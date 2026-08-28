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
import { NotionClient, blockToMarkdown, extractTitle } from "@/server/integrations/notion/client";
import type { NotionBlock, NotionSearchResult } from "@/server/integrations/notion/client";

const Credentials = z.object({ accessToken: z.string().min(1) });

const Cursor = z.object({
  /** ISO timestamp of the newest page seen in a completed sync. */
  lastEditedWatermark: z.string().nullish(),
  /** Notion pagination cursor, so a crashed sync resumes mid-walk. */
  searchCursor: z.string().nullish(),
  /** Watermark being built by the run in progress; promoted when it finishes. */
  pendingWatermark: z.string().nullish(),
});

/** Depth cap: Notion allows deep nesting, and a runaway walk is a real risk. */
const MAX_BLOCK_DEPTH = 4;

function redirectUri(): string {
  return `${getEnv().APP_URL}/api/integrations/notion/callback`;
}

/**
 * Recursively renders a page's block tree to Markdown.
 *
 * Notion returns children one level at a time, so a page is many requests.
 * The rate limiter inside NotionClient is what keeps that polite.
 */
async function renderPage(client: NotionClient, pageId: string, depth = 0): Promise<string> {
  if (depth > MAX_BLOCK_DEPTH) return "";

  const lines: string[] = [];
  let cursor: string | undefined;

  do {
    const page = await client.listBlockChildren(pageId, cursor);
    for (const block of page.results as NotionBlock[]) {
      const rendered = blockToMarkdown(block, depth);
      if (rendered !== null) lines.push(rendered);

      if (block.has_children && block.type !== "child_page" && block.type !== "child_database") {
        const nested = await renderPage(client, block.id, depth + 1);
        if (nested.trim().length > 0) lines.push(nested);
      }
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);

  // Headings need blank lines around them for the chunker to see them.
  return lines.join("\n\n");
}

function toNormalizedDocument(page: NotionSearchResult, content: string): NormalizedDocument {
  const parentType = typeof page.parent === "object" ? String((page.parent as { type?: string }).type ?? "") : "";
  return {
    externalId: page.id,
    title: extractTitle(page),
    url: page.url ?? null,
    content: normalizeText(content),
    metadata: {
      provider: "notion",
      notionParentType: parentType,
      createdTime: page.created_time ?? null,
      lastEditedTime: page.last_edited_time ?? null,
    },
    sourceUpdatedAt: page.last_edited_time ? new Date(page.last_edited_time) : null,
  };
}

export const notionIntegration: SourceIntegration = {
  provider: "notion",
  displayName: "Notion",
  description: "Pages and databases from a Notion workspace.",
  supportsIncrementalSync: true,

  isConfigured(): boolean {
    const env = getEnv();
    return Boolean(env.NOTION_CLIENT_ID && env.NOTION_CLIENT_SECRET);
  },

  buildAuthorizationUrl(state: string): string {
    const env = getEnv();
    if (!env.NOTION_CLIENT_ID) throw validationFailed("Notion is not configured on this deployment");

    const params = new URLSearchParams({
      client_id: env.NOTION_CLIENT_ID,
      response_type: "code",
      owner: "user",
      redirect_uri: redirectUri(),
      state,
    });
    return `https://api.notion.com/v1/oauth/authorize?${params.toString()}`;
  },

  async completeAuthorization(code: string): Promise<IntegrationConnection> {
    const env = getEnv();
    if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) {
      throw validationFailed("Notion is not configured on this deployment");
    }

    const token = await NotionClient.exchangeCode(
      code,
      env.NOTION_CLIENT_ID,
      env.NOTION_CLIENT_SECRET,
      redirectUri(),
    );

    return {
      externalAccountId: token.workspace_id,
      displayName: token.workspace_name ?? "Notion workspace",
      credentials: { accessToken: token.access_token },
      config: { botId: token.bot_id ?? null },
    };
  },

  async *sync(context: SyncContext): AsyncGenerator<SyncPage, void, undefined> {
    const credentials = Credentials.safeParse(context.credentials);
    if (!credentials.success) throw upstreamUnavailable("Notion credentials are missing or malformed");

    const cursor = Cursor.parse(context.cursor ?? {});
    const client = new NotionClient({ accessToken: credentials.data.accessToken, logger: context.logger });

    const watermark =
      context.mode === "incremental" && cursor.lastEditedWatermark
        ? new Date(cursor.lastEditedWatermark)
        : null;

    // Results are newest-first, so the first page of the first request holds
    // the watermark for the next incremental run.
    let pendingWatermark = cursor.pendingWatermark ?? null;
    let searchCursor = cursor.searchCursor ?? undefined;
    let reachedWatermark = false;

    do {
      if (context.signal?.aborted) return;

      const results = await client.searchPages(searchCursor);
      const documents: NormalizedDocument[] = [];
      const deletedExternalIds: string[] = [];

      for (const page of results.results) {
        if (pendingWatermark === null && page.last_edited_time) pendingWatermark = page.last_edited_time;

        // Trashed and archived pages are deletions, not documents.
        if (page.archived || page.in_trash) {
          deletedExternalIds.push(page.id);
          continue;
        }

        if (watermark && page.last_edited_time && new Date(page.last_edited_time) <= watermark) {
          // Sorted descending: everything after this is older still.
          reachedWatermark = true;
          break;
        }

        const content = await renderPage(client, page.id);
        // A page with no text is a container, not knowledge — skip it.
        if (content.trim().length === 0) continue;
        documents.push(toNormalizedDocument(page, content));
      }

      searchCursor = reachedWatermark ? undefined : results.next_cursor ?? undefined;
      const finished = reachedWatermark || !results.has_more || !searchCursor;

      yield {
        documents,
        deletedExternalIds,
        cursor: finished
          ? { lastEditedWatermark: pendingWatermark ?? cursor.lastEditedWatermark ?? null }
          : {
              lastEditedWatermark: cursor.lastEditedWatermark ?? null,
              pendingWatermark,
              searchCursor,
            },
      };

      if (finished) return;
    } while (searchCursor);
  },
};
