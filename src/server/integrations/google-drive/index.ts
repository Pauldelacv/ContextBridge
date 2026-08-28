import { z } from "zod";
import { getEnv } from "@/server/config/env";
import { upstreamUnavailable, validationFailed } from "@/server/errors";
import { htmlToText, normalizeText } from "@/server/ingestion/normalize";
import type { NormalizedDocument } from "@/server/ingestion/normalize";
import type {
  IntegrationConnection,
  SourceIntegration,
  SyncContext,
  SyncPage,
} from "@/server/integrations/types";
import { GoogleDriveClient, isIngestibleMimeType } from "@/server/integrations/google-drive/client";
import type { DriveFile } from "@/server/integrations/google-drive/client";

const Credentials = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().nullish(),
  expiresAt: z.number().nullish(),
});

const Cursor = z.object({
  /** Drive's change-feed token — the whole basis of incremental sync. */
  startPageToken: z.string().nullish(),
  /** Pagination token for a full sync that has not finished yet. */
  filePageToken: z.string().nullish(),
});

const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "openid",
  "email",
  "profile",
].join(" ");

function redirectUri(): string {
  return `${getEnv().APP_URL}/api/oauth/google_drive/callback`;
}

function toNormalizedDocument(file: DriveFile, rawContent: string): NormalizedDocument {
  // HTML exports arrive as markup; everything else is already text.
  const content = file.mimeType === "text/html" ? htmlToText(rawContent) : rawContent;
  const owner = file.owners[0];

  return {
    externalId: file.id,
    title: file.name,
    url: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
    content: normalizeText(content),
    metadata: {
      provider: "google_drive",
      mimeType: file.mimeType,
      owner: owner?.displayName ?? owner?.emailAddress ?? null,
      createdTime: file.createdTime ?? null,
      modifiedTime: file.modifiedTime ?? null,
    },
    sourceUpdatedAt: file.modifiedTime ? new Date(file.modifiedTime) : null,
  };
}

export const googleDriveIntegration: SourceIntegration = {
  provider: "google_drive",
  displayName: "Google Drive",
  description: "Docs, Sheets, Slides and text files from Google Drive.",
  supportsIncrementalSync: true,

  isConfigured(): boolean {
    const env = getEnv();
    return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  },

  buildAuthorizationUrl(state: string): string {
    const env = getEnv();
    if (!env.GOOGLE_CLIENT_ID) throw validationFailed("Google Drive is not configured on this deployment");

    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: SCOPES,
      // Required to receive a refresh token: syncs outlive a 1-hour access token.
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  },

  async completeAuthorization(code: string): Promise<IntegrationConnection> {
    const env = getEnv();
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw validationFailed("Google Drive is not configured on this deployment");
    }

    const token = await GoogleDriveClient.exchangeCode(
      code,
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      redirectUri(),
    );
    const profile = await GoogleDriveClient.fetchUserInfo(token.access_token);

    return {
      externalAccountId: profile.sub ?? profile.email ?? "google-drive",
      displayName: profile.email ? `Google Drive (${profile.email})` : "Google Drive",
      credentials: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? null,
        expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : null,
      },
      config: { email: profile.email ?? null },
    };
  },

  async *sync(context: SyncContext): AsyncGenerator<SyncPage, void, undefined> {
    const env = getEnv();
    const credentials = Credentials.safeParse(context.credentials);
    if (!credentials.success) throw upstreamUnavailable("Google Drive credentials are missing or malformed");
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw validationFailed("Google Drive is not configured on this deployment");
    }

    const cursor = Cursor.parse(context.cursor ?? {});
    const client = new GoogleDriveClient(
      credentials.data,
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      context.logger,
    );

    /**
     * Hand a rotated access token back to the driver so it is stored. Without
     * this the refreshed token is discarded and every subsequent sync pays for
     * a fresh refresh round trip.
     */
    const persistRefreshedCredentials = async (): Promise<void> => {
      if (!client.didRefresh || !context.onCredentialsRefreshed) return;
      await context.onCredentialsRefreshed(
        client.currentCredentials as unknown as Record<string, unknown>,
      );
    };

    const load = async (file: DriveFile): Promise<NormalizedDocument | null> => {
      if (!isIngestibleMimeType(file.mimeType)) return null;
      const raw = await client.fetchContent(file);
      if (raw === null || raw.trim().length === 0) return null;
      return toNormalizedDocument(file, raw);
    };

    // Incremental path: walk the change feed from the stored token.
    if (context.mode === "incremental" && cursor.startPageToken) {
      let pageToken: string | null = cursor.startPageToken;

      while (pageToken) {
        if (context.signal?.aborted) return;

        const changes = await client.listChanges(pageToken);
        const documents: NormalizedDocument[] = [];
        const deletedExternalIds: string[] = [];

        for (const change of changes.changes) {
          if (change.removed || !change.file || change.file.trashed) {
            deletedExternalIds.push(change.fileId);
            continue;
          }
          const document = await load(change.file);
          if (document) documents.push(document);
        }

        // newStartPageToken means the feed is drained; otherwise keep paging.
        const nextToken: string | null = changes.nextPageToken ?? null;
        const settled = changes.newStartPageToken ?? null;

        await persistRefreshedCredentials();
        yield {
          documents,
          deletedExternalIds,
          cursor: { startPageToken: settled ?? nextToken ?? pageToken },
        };

        if (settled || !nextToken) return;
        pageToken = nextToken;
      }
      return;
    }

    // Full path: enumerate every readable file, then take a change token so the
    // next run can go incremental from this exact point.
    let filePageToken = cursor.filePageToken ?? undefined;

    for (;;) {
      if (context.signal?.aborted) return;

      const page = await client.listFiles(filePageToken);
      const documents: NormalizedDocument[] = [];

      for (const file of page.files) {
        const document = await load(file);
        if (document) documents.push(document);
      }

      filePageToken = page.nextPageToken ?? undefined;

      await persistRefreshedCredentials();

      if (filePageToken) {
        yield { documents, cursor: { filePageToken } };
        continue;
      }

      const startPageToken = await client.getStartPageToken();
      yield { documents, cursor: { startPageToken } };
      return;
    }
  },
};
