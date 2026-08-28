import { z } from "zod";
import { createRateLimiter } from "@/server/http/rate-limit";
import { HttpStatusError, withRetry } from "@/server/http/retry";
import type { Logger } from "@/server/logging/logger";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/**
 * Notion documents a ~3 requests/second average per integration. Staying under
 * it deliberately is cheaper than discovering it through 429s.
 */
const limiter = createRateLimiter({ tokensPerInterval: 3, intervalMs: 1000, burst: 3 });

const RichText = z.array(z.object({ plain_text: z.string() })).default([]);

const SearchResult = z.object({
  object: z.string(),
  id: z.string(),
  url: z.string().nullish(),
  created_time: z.string().nullish(),
  last_edited_time: z.string().nullish(),
  archived: z.boolean().default(false),
  in_trash: z.boolean().default(false),
  parent: z.record(z.string(), z.unknown()).default({}),
  properties: z.record(z.string(), z.unknown()).default({}),
});
export type NotionSearchResult = z.infer<typeof SearchResult>;

const SearchResponse = z.object({
  results: z.array(SearchResult),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

const Block: z.ZodType<NotionBlock> = z.lazy(() =>
  z.object({
    id: z.string(),
    type: z.string(),
    has_children: z.boolean().default(false),
  }).catchall(z.unknown()),
) as z.ZodType<NotionBlock>;

export interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  [key: string]: unknown;
}

const BlockListResponse = z.object({
  results: z.array(Block),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

const TokenResponse = z.object({
  access_token: z.string(),
  workspace_id: z.string(),
  workspace_name: z.string().nullish(),
  bot_id: z.string().nullish(),
});
export type NotionToken = z.infer<typeof TokenResponse>;

export interface NotionClientOptions {
  accessToken: string;
  logger?: Logger;
}

export class NotionClient {
  constructor(private readonly options: NotionClientOptions) {}

  private async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    return withRetry(
      async () => {
        await limiter.acquire();
        const response = await fetch(`${NOTION_API}${path}`, {
          ...init,
          headers: {
            authorization: `Bearer ${this.options.accessToken}`,
            "notion-version": NOTION_VERSION,
            "content-type": "application/json",
            ...init.headers,
          },
        });

        if (!response.ok) {
          const retryAfter = response.headers.get("retry-after");
          throw new HttpStatusError(
            response.status,
            `Notion ${path} returned ${response.status}`,
            await response.text().catch(() => undefined),
            retryAfter ? Number(retryAfter) * 1000 : undefined,
          );
        }
        return schema.parse(await response.json());
      },
      { label: `notion${path}`, logger: this.options.logger },
    );
  }

  /**
   * Notion's search endpoint sorted by last_edited_time descending is what
   * makes incremental sync possible: walk until we reach documents older than
   * the last watermark, then stop.
   */
  async searchPages(cursor?: string): Promise<z.infer<typeof SearchResponse>> {
    return this.request("/search", SearchResponse, {
      method: "POST",
      body: JSON.stringify({
        filter: { property: "object", value: "page" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    });
  }

  async listBlockChildren(blockId: string, cursor?: string): Promise<z.infer<typeof BlockListResponse>> {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    return this.request(`/blocks/${blockId}/children?${query.toString()}`, BlockListResponse);
  }

  static async exchangeCode(
    code: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string,
  ): Promise<NotionToken> {
    return withRetry(
      async () => {
        const response = await fetch(`${NOTION_API}/oauth/token`, {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
            "content-type": "application/json",
            "notion-version": NOTION_VERSION,
          },
          body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
        });
        if (!response.ok) {
          throw new HttpStatusError(
            response.status,
            `Notion token exchange returned ${response.status}`,
            await response.text().catch(() => undefined),
          );
        }
        return TokenResponse.parse(await response.json());
      },
      { label: "notion.oauth.token" },
    );
  }
}

function plainText(value: unknown): string {
  const parsed = RichText.safeParse(value);
  if (!parsed.success) return "";
  return parsed.data.map((part) => part.plain_text).join("");
}

/** Pulls the page title out of whichever property happens to hold it. */
export function extractTitle(page: NotionSearchResult): string {
  for (const property of Object.values(page.properties)) {
    if (
      typeof property === "object" &&
      property !== null &&
      (property as { type?: string }).type === "title"
    ) {
      const text = plainText((property as { title?: unknown }).title);
      if (text.trim().length > 0) return text;
    }
  }
  return "Untitled";
}

/**
 * Notion's block model into Markdown.
 *
 * Markdown rather than plain text because the chunker uses heading structure
 * to decide where to split — throwing the headings away here would make every
 * downstream chunk worse.
 */
export function blockToMarkdown(block: NotionBlock, depth: number): string | null {
  const type = block.type;
  const payload = block[type];
  if (typeof payload !== "object" || payload === null) return null;

  const text = plainText((payload as { rich_text?: unknown }).rich_text);
  const indent = "  ".repeat(depth);

  switch (type) {
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `${indent}- ${text}`;
    case "numbered_list_item":
      return `${indent}1. ${text}`;
    case "to_do": {
      const checked = (payload as { checked?: boolean }).checked === true;
      return `${indent}- [${checked ? "x" : " "}] ${text}`;
    }
    case "toggle":
    case "paragraph":
    case "quote":
    case "callout":
      return text.trim().length > 0 ? (type === "quote" ? `> ${text}` : text) : null;
    case "code": {
      const language = (payload as { language?: string }).language ?? "";
      return text.trim().length > 0 ? `\`\`\`${language}\n${text}\n\`\`\`` : null;
    }
    case "divider":
      return "---";
    case "table_row": {
      const cells = (payload as { cells?: unknown[] }).cells ?? [];
      const rendered = cells.map((cell) => plainText(cell)).join(" | ");
      return rendered.trim().length > 0 ? `| ${rendered} |` : null;
    }
    case "child_page":
    case "child_database": {
      const title = (payload as { title?: string }).title;
      return title ? `## ${title}` : null;
    }
    case "image":
    case "video":
    case "file":
    case "pdf": {
      const caption = plainText((payload as { caption?: unknown }).caption);
      return caption.trim().length > 0 ? `[${type}] ${caption}` : null;
    }
    default:
      // Unknown block types still contribute their text rather than vanishing.
      return text.trim().length > 0 ? text : null;
  }
}
