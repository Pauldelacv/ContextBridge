import { z } from "zod";
import { createRateLimiter } from "@/server/http/rate-limit";
import { HttpStatusError, withRetry } from "@/server/http/retry";
import type { Logger } from "@/server/logging/logger";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

const limiter = createRateLimiter({ tokensPerInterval: 8, intervalMs: 1000, burst: 12 });

export const DriveFile = z.object({
  id: z.string(),
  name: z.string().default("Untitled"),
  mimeType: z.string(),
  webViewLink: z.string().nullish(),
  modifiedTime: z.string().nullish(),
  createdTime: z.string().nullish(),
  trashed: z.boolean().default(false),
  owners: z.array(z.object({ displayName: z.string().nullish(), emailAddress: z.string().nullish() })).default([]),
});
export type DriveFile = z.infer<typeof DriveFile>;

const FileListResponse = z.object({
  files: z.array(DriveFile).default([]),
  nextPageToken: z.string().nullish(),
});

const ChangeListResponse = z.object({
  changes: z
    .array(
      z.object({
        fileId: z.string(),
        removed: z.boolean().default(false),
        file: DriveFile.nullish(),
      }),
    )
    .default([]),
  nextPageToken: z.string().nullish(),
  newStartPageToken: z.string().nullish(),
});

const StartPageTokenResponse = z.object({ startPageToken: z.string() });

const TokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string().nullish(),
  expires_in: z.number().nullish(),
});

const UserInfoResponse = z.object({
  email: z.string().nullish(),
  sub: z.string().nullish(),
  name: z.string().nullish(),
});

/**
 * Native Google formats have no bytes to download — they must be exported.
 * Anything not in this map is either downloaded directly (plain text) or
 * skipped (images, video, binaries we cannot read).
 */
export const GOOGLE_EXPORT_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
};

export const DOWNLOADABLE_TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/json",
  "application/rtf",
]);

export function isIngestibleMimeType(mimeType: string): boolean {
  return mimeType in GOOGLE_EXPORT_TYPES || DOWNLOADABLE_TEXT_TYPES.has(mimeType);
}

export interface GoogleCredentials {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number | null;
}

export class GoogleDriveClient {
  private accessToken: string;
  private refreshed = false;

  constructor(
    private credentials: GoogleCredentials,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly logger?: Logger,
  ) {
    this.accessToken = credentials.accessToken;
  }

  /** True when a refresh happened, so the caller can persist the new token. */
  get didRefresh(): boolean {
    return this.refreshed;
  }

  get currentCredentials(): GoogleCredentials {
    return { ...this.credentials, accessToken: this.accessToken };
  }

  /**
   * Google access tokens last an hour, which is shorter than a large sync.
   * Refreshing transparently on a 401 keeps that out of every call site.
   */
  private async refreshAccessToken(): Promise<boolean> {
    const refreshToken = this.credentials.refreshToken;
    if (!refreshToken) return false;

    const response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!response.ok) return false;

    const token = TokenResponse.parse(await response.json());
    this.accessToken = token.access_token;
    this.credentials = {
      ...this.credentials,
      accessToken: token.access_token,
      expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : null,
    };
    this.refreshed = true;
    this.logger?.info("google.token.refreshed");
    return true;
  }

  private async fetchRaw(url: string): Promise<Response> {
    return withRetry(
      async () => {
        await limiter.acquire();
        let response = await fetch(url, {
          headers: { authorization: `Bearer ${this.accessToken}` },
        });

        if (response.status === 401 && (await this.refreshAccessToken())) {
          response = await fetch(url, { headers: { authorization: `Bearer ${this.accessToken}` } });
        }

        if (!response.ok) {
          const retryAfter = response.headers.get("retry-after");
          throw new HttpStatusError(
            response.status,
            `Google Drive request returned ${response.status}`,
            await response.text().catch(() => undefined),
            retryAfter ? Number(retryAfter) * 1000 : undefined,
          );
        }
        return response;
      },
      { label: "google-drive.request", logger: this.logger },
    );
  }

  private async request<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    const response = await this.fetchRaw(url);
    return schema.parse(await response.json());
  }

  async listFiles(pageToken?: string): Promise<z.infer<typeof FileListResponse>> {
    const query = new URLSearchParams({
      q: "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
      fields: "files(id,name,mimeType,webViewLink,modifiedTime,createdTime,trashed,owners),nextPageToken",
      pageSize: "100",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      corpora: "user",
    });
    if (pageToken) query.set("pageToken", pageToken);
    return this.request(`${DRIVE_API}/files?${query.toString()}`, FileListResponse);
  }

  async getStartPageToken(): Promise<string> {
    const response = await this.request(
      `${DRIVE_API}/changes/startPageToken?supportsAllDrives=true`,
      StartPageTokenResponse,
    );
    return response.startPageToken;
  }

  async listChanges(pageToken: string): Promise<z.infer<typeof ChangeListResponse>> {
    const query = new URLSearchParams({
      pageToken,
      fields:
        "changes(fileId,removed,file(id,name,mimeType,webViewLink,modifiedTime,createdTime,trashed,owners)),nextPageToken,newStartPageToken",
      pageSize: "100",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    return this.request(`${DRIVE_API}/changes?${query.toString()}`, ChangeListResponse);
  }

  /** Returns null for files whose bytes we cannot turn into text. */
  async fetchContent(file: DriveFile): Promise<string | null> {
    const exportType = GOOGLE_EXPORT_TYPES[file.mimeType];

    if (exportType) {
      const query = new URLSearchParams({ mimeType: exportType });
      const response = await this.fetchRaw(`${DRIVE_API}/files/${file.id}/export?${query.toString()}`);
      return response.text();
    }

    if (DOWNLOADABLE_TEXT_TYPES.has(file.mimeType)) {
      const response = await this.fetchRaw(`${DRIVE_API}/files/${file.id}?alt=media&supportsAllDrives=true`);
      return response.text();
    }

    return null;
  }

  static async exchangeCode(
    code: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string,
  ): Promise<z.infer<typeof TokenResponse>> {
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!response.ok) {
      throw new HttpStatusError(
        response.status,
        `Google token exchange returned ${response.status}`,
        await response.text().catch(() => undefined),
      );
    }
    return TokenResponse.parse(await response.json());
  }

  static async fetchUserInfo(accessToken: string): Promise<z.infer<typeof UserInfoResponse>> {
    const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return {};
    return UserInfoResponse.parse(await response.json());
  }
}
