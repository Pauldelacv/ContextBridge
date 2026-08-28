import { z } from "zod";
import { createRateLimiter } from "@/server/http/rate-limit";
import { HttpStatusError, withRetry } from "@/server/http/retry";
import { upstreamUnavailable } from "@/server/errors";
import type { Logger } from "@/server/logging/logger";

const SLACK_API = "https://slack.com/api";

/** Slack's Tier-3 methods allow ~50 requests/minute. */
const limiter = createRateLimiter({ tokensPerInterval: 45, intervalMs: 60_000, burst: 10 });

export const SlackMessage = z.object({
  type: z.string().default("message"),
  subtype: z.string().nullish(),
  ts: z.string(),
  thread_ts: z.string().nullish(),
  user: z.string().nullish(),
  bot_id: z.string().nullish(),
  text: z.string().default(""),
  reply_count: z.number().nullish(),
});
export type SlackMessage = z.infer<typeof SlackMessage>;

export const SlackChannel = z.object({
  id: z.string(),
  name: z.string().default("channel"),
  is_archived: z.boolean().default(false),
  is_private: z.boolean().default(false),
  purpose: z.object({ value: z.string().default("") }).default({ value: "" }),
  topic: z.object({ value: z.string().default("") }).default({ value: "" }),
});
export type SlackChannel = z.infer<typeof SlackChannel>;

/** Every Slack response carries `ok`; a false `ok` is an error with HTTP 200. */
function slackEnvelope<T extends z.ZodRawShape>(shape: T) {
  return z.object({
    ok: z.boolean(),
    error: z.string().nullish(),
    response_metadata: z.object({ next_cursor: z.string().nullish() }).nullish(),
    ...shape,
  });
}

const ConversationsList = slackEnvelope({ channels: z.array(SlackChannel).default([]) });
const ConversationsHistory = slackEnvelope({
  messages: z.array(SlackMessage).default([]),
  has_more: z.boolean().default(false),
});
const UsersList = slackEnvelope({
  members: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().default(""),
        real_name: z.string().nullish(),
        deleted: z.boolean().default(false),
      }),
    )
    .default([]),
});

const OauthAccess = z.object({
  ok: z.boolean(),
  error: z.string().nullish(),
  access_token: z.string().nullish(),
  team: z.object({ id: z.string(), name: z.string().nullish() }).nullish(),
  bot_user_id: z.string().nullish(),
  scope: z.string().nullish(),
});

export class SlackClient {
  constructor(
    private readonly accessToken: string,
    private readonly logger?: Logger,
  ) {}

  private async call<T>(method: string, schema: z.ZodType<T>, params: Record<string, string> = {}): Promise<T> {
    return withRetry(
      async () => {
        await limiter.acquire();
        const query = new URLSearchParams(params);
        const response = await fetch(`${SLACK_API}/${method}?${query.toString()}`, {
          headers: { authorization: `Bearer ${this.accessToken}` },
        });

        if (!response.ok) {
          const retryAfter = response.headers.get("retry-after");
          throw new HttpStatusError(
            response.status,
            `Slack ${method} returned ${response.status}`,
            await response.text().catch(() => undefined),
            retryAfter ? Number(retryAfter) * 1000 : undefined,
          );
        }

        const body = schema.parse(await response.json());
        const envelope = body as { ok?: boolean; error?: string | null };
        if (envelope.ok === false) {
          // `ratelimited` deserves a retry; a bad scope never will succeed.
          if (envelope.error === "ratelimited") {
            throw new HttpStatusError(429, "Slack rate limited");
          }
          throw upstreamUnavailable(`Slack ${method} failed: ${envelope.error ?? "unknown error"}`);
        }
        return body;
      },
      { label: `slack.${method}`, logger: this.logger },
    );
  }

  async listChannels(cursor?: string): Promise<z.infer<typeof ConversationsList>> {
    return this.call("conversations.list", ConversationsList, {
      types: "public_channel",
      exclude_archived: "true",
      limit: "200",
      ...(cursor ? { cursor } : {}),
    });
  }

  async fetchHistory(
    channelId: string,
    options: { oldest?: string; cursor?: string } = {},
  ): Promise<z.infer<typeof ConversationsHistory>> {
    return this.call("conversations.history", ConversationsHistory, {
      channel: channelId,
      limit: "200",
      ...(options.oldest ? { oldest: options.oldest } : {}),
      ...(options.cursor ? { cursor: options.cursor } : {}),
    });
  }

  async fetchThreadReplies(channelId: string, threadTs: string): Promise<SlackMessage[]> {
    const response = await this.call("conversations.replies", ConversationsHistory, {
      channel: channelId,
      ts: threadTs,
      limit: "200",
    });
    return response.messages;
  }

  async joinChannel(channelId: string): Promise<void> {
    // Reading history requires membership; failing to join is not fatal.
    try {
      await this.call("conversations.join", slackEnvelope({}), { channel: channelId });
    } catch (error) {
      this.logger?.warn("slack.join.failed", { channelId, error });
    }
  }

  /** id -> display name, so stored messages read as people rather than U0123. */
  async fetchUserDirectory(): Promise<Map<string, string>> {
    const directory = new Map<string, string>();
    let cursor: string | undefined;

    do {
      const response = await this.call("users.list", UsersList, {
        limit: "200",
        ...(cursor ? { cursor } : {}),
      });
      for (const member of response.members) {
        if (!member.deleted) directory.set(member.id, member.real_name ?? member.name);
      }
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return directory;
  }

  async postMessage(channel: string, text: string, threadTs?: string): Promise<void> {
    await withRetry(
      async () => {
        const response = await fetch(`${SLACK_API}/chat.postMessage`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.accessToken}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
        });
        if (!response.ok) {
          throw new HttpStatusError(response.status, `Slack chat.postMessage returned ${response.status}`);
        }
      },
      { label: "slack.chat.postMessage", logger: this.logger },
    );
  }

  static async exchangeCode(
    code: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string,
  ): Promise<z.infer<typeof OauthAccess>> {
    const response = await fetch(`${SLACK_API}/oauth.v2.access`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    });
    const body = OauthAccess.parse(await response.json());
    if (!body.ok || !body.access_token) {
      throw upstreamUnavailable(`Slack OAuth failed: ${body.error ?? "unknown error"}`);
    }
    return body;
  }
}

/**
 * Slack's mrkdwn into readable text: user mentions become names, links keep
 * their label, and the escaping is undone. Without this, every chunk is full
 * of `<@U024BE7LH>` noise that pollutes the embedding.
 */
export function renderSlackText(text: string, users: Map<string, string>): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${users.get(id) ?? id}`)
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, name: string) => `#${name || id}`)
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}
