import { z } from "zod";
import { getEnv } from "@/server/config/env";
import { upstreamUnavailable, validationFailed } from "@/server/errors";
import { normalizeText } from "@/server/ingestion/normalize";
import type { NormalizedDocument } from "@/server/ingestion/normalize";
import type {
  IntegrationConnection,
  SourceIntegration,
  SyncContext,
  SyncPage,
} from "@/server/integrations/types";
import { SlackClient, renderSlackText } from "@/server/integrations/slack/client";
import type { SlackChannel, SlackMessage } from "@/server/integrations/slack/client";

const Credentials = z.object({ accessToken: z.string().min(1) });

const Cursor = z.object({
  /** Per-channel high-water mark: the newest message ts already ingested. */
  channelWatermarks: z.record(z.string(), z.string()).default({}),
  /** Channel this run stopped on, so a long workspace resumes mid-walk. */
  channelCursor: z.string().nullish(),
});

const SCOPES = [
  "channels:read",
  "channels:history",
  "channels:join",
  "users:read",
  "chat:write",
  "commands",
].join(",");

/** A conversation shorter than this is chatter, not knowledge. */
const MIN_THREAD_CHARACTERS = 80;

function redirectUri(): string {
  return `${getEnv().APP_URL}/api/integrations/slack/callback`;
}

/**
 * Slack's unit of knowledge is a conversation, not a message. A single message
 * embedded alone ("yes, that's right") is meaningless; the thread it belongs
 * to is the thing worth retrieving. So each document is one thread — or one
 * standalone message with its replies, if any.
 */
function threadToDocument(
  channel: SlackChannel,
  root: SlackMessage,
  replies: SlackMessage[],
  users: Map<string, string>,
  teamId: string,
): NormalizedDocument | null {
  const messages = [root, ...replies.filter((reply) => reply.ts !== root.ts)];

  const lines = messages
    .filter((message) => message.text.trim().length > 0)
    .map((message) => {
      const author = message.user ? (users.get(message.user) ?? message.user) : (message.bot_id ?? "bot");
      const when = new Date(Number(message.ts.split(".")[0]) * 1000).toISOString();
      return `${author} (${when}): ${renderSlackText(message.text, users)}`;
    });

  if (lines.length === 0) return null;

  const body = lines.join("\n\n");
  if (body.length < MIN_THREAD_CHARACTERS) return null;

  const firstLine = renderSlackText(root.text, users).split("\n")[0] ?? "Slack thread";
  const title = `#${channel.name}: ${firstLine.slice(0, 120)}`;
  const permalinkTs = root.ts.replace(".", "");

  return {
    externalId: `${channel.id}:${root.ts}`,
    title,
    url: `https://app.slack.com/archives/${channel.id}/p${permalinkTs}`,
    // A heading gives the chunker structure and names the channel in citations.
    content: normalizeText(`# ${title}\n\n${body}`),
    metadata: {
      provider: "slack",
      channelId: channel.id,
      channelName: channel.name,
      teamId,
      messageCount: lines.length,
      threadTs: root.ts,
    },
    sourceUpdatedAt: new Date(Number(messages[messages.length - 1]!.ts.split(".")[0]) * 1000),
  };
}

export const slackIntegration: SourceIntegration = {
  provider: "slack",
  displayName: "Slack",
  description: "Threads and conversations from public Slack channels.",
  supportsIncrementalSync: true,

  isConfigured(): boolean {
    const env = getEnv();
    return Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET);
  },

  buildAuthorizationUrl(state: string): string {
    const env = getEnv();
    if (!env.SLACK_CLIENT_ID) throw validationFailed("Slack is not configured on this deployment");

    const params = new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      scope: SCOPES,
      redirect_uri: redirectUri(),
      state,
    });
    return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
  },

  async completeAuthorization(code: string): Promise<IntegrationConnection> {
    const env = getEnv();
    if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
      throw validationFailed("Slack is not configured on this deployment");
    }

    const token = await SlackClient.exchangeCode(
      code,
      env.SLACK_CLIENT_ID,
      env.SLACK_CLIENT_SECRET,
      redirectUri(),
    );

    return {
      // The team id is how an inbound slash command finds its organization.
      externalAccountId: token.team?.id ?? "slack",
      displayName: token.team?.name ?? "Slack workspace",
      credentials: { accessToken: token.access_token! },
      config: { teamId: token.team?.id ?? null, botUserId: token.bot_user_id ?? null },
    };
  },

  async *sync(context: SyncContext): AsyncGenerator<SyncPage, void, undefined> {
    const credentials = Credentials.safeParse(context.credentials);
    if (!credentials.success) throw upstreamUnavailable("Slack credentials are missing or malformed");

    const cursor = Cursor.parse(context.cursor ?? {});
    const client = new SlackClient(credentials.data.accessToken, context.logger);
    const teamId = String(context.config.teamId ?? "");

    const users = await client.fetchUserDirectory();

    // Enumerate channels first: the walk below is per-channel and resumable.
    const channels: SlackChannel[] = [];
    let channelPageCursor: string | undefined;
    do {
      const page = await client.listChannels(channelPageCursor);
      channels.push(...page.channels.filter((channel) => !channel.is_archived));
      channelPageCursor = page.response_metadata?.next_cursor || undefined;
    } while (channelPageCursor);

    const watermarks = { ...cursor.channelWatermarks };
    const resumeFrom = cursor.channelCursor
      ? channels.findIndex((channel) => channel.id === cursor.channelCursor)
      : 0;
    const startIndex = resumeFrom >= 0 ? resumeFrom : 0;

    for (let index = startIndex; index < channels.length; index += 1) {
      if (context.signal?.aborted) return;

      const channel = channels[index]!;
      const since = context.mode === "incremental" ? watermarks[channel.id] : undefined;

      let history;
      try {
        history = await client.fetchHistory(channel.id, since ? { oldest: since } : {});
      } catch (error) {
        // not_in_channel is the common case on a fresh install: join and retry.
        context.logger.warn("slack.history.retry", { channelId: channel.id, error });
        await client.joinChannel(channel.id);
        history = await client.fetchHistory(channel.id, since ? { oldest: since } : {});
      }

      const documents: NormalizedDocument[] = [];
      let newest = since ?? "0";

      for (const message of history.messages) {
        if (message.ts > newest) newest = message.ts;
        // Joins, leaves and channel_topic events are not knowledge.
        if (message.subtype && message.subtype !== "thread_broadcast") continue;

        const isThreadReply = message.thread_ts && message.thread_ts !== message.ts;
        if (isThreadReply) continue;

        const replies =
          (message.reply_count ?? 0) > 0
            ? await client.fetchThreadReplies(channel.id, message.ts)
            : [];

        const document = threadToDocument(channel, message, replies, users, teamId);
        if (document) documents.push(document);
      }

      watermarks[channel.id] = newest;
      const isLastChannel = index === channels.length - 1;

      yield {
        documents,
        cursor: {
          channelWatermarks: watermarks,
          channelCursor: isLastChannel ? null : channels[index + 1]!.id,
        },
      };
    }
  },
};
