import type { IntegrationProvider } from "@/server/db/schema";
import type { NormalizedDocument } from "@/server/ingestion/normalize";
import type { Logger } from "@/server/logging/logger";

export type { IntegrationProvider, NormalizedDocument };

/** Opaque provider-specific resume state, persisted on the integration row. */
export type SyncCursor = Record<string, unknown>;

export interface IntegrationConnection {
  /** Provider-side workspace/account/team id. Routes inbound webhooks. */
  externalAccountId: string;
  displayName: string;
  /** Encrypted before it touches the database. */
  credentials: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface SyncContext {
  organizationId: string;
  integrationId: string;
  credentials: Record<string, unknown>;
  config: Record<string, unknown>;
  cursor: SyncCursor;
  /**
   * "full" walks everything the connection can see and enables deletion
   * reconciliation; "incremental" only asks for what changed since `cursor`.
   */
  mode: "full" | "incremental";
  logger: Logger;
  signal?: AbortSignal;
}

/**
 * One page of sync results.
 *
 * Pages exist so a sync can be resumed: the driver persists `cursor` after
 * each page, so a worker that dies halfway through a 10,000-page Notion
 * workspace picks up where it stopped instead of starting over.
 */
export interface SyncPage {
  documents: NormalizedDocument[];
  /** Ids the provider reports as removed (only providers with a change feed). */
  deletedExternalIds?: string[];
  /** State to persist before the next page. */
  cursor: SyncCursor;
}

/**
 * The contract every data source implements. Notion established it; Google
 * Drive and Slack satisfy the same shape, which is why adding a source touches
 * no code outside its own directory plus one line in the registry.
 */
export interface SourceIntegration {
  readonly provider: IntegrationProvider;
  readonly displayName: string;
  readonly description: string;
  /** False when the deployment has no client id/secret for this provider. */
  isConfigured(): boolean;
  /** Whether `sync` can honour mode: "incremental". */
  readonly supportsIncrementalSync: boolean;

  /** Step 1 of OAuth: where to send the user. */
  buildAuthorizationUrl(state: string): string;
  /** Step 2 of OAuth: turn the callback code into stored credentials. */
  completeAuthorization(code: string): Promise<IntegrationConnection>;

  /**
   * Yields pages until exhausted. Implementations must be restartable from any
   * cursor they previously yielded.
   */
  sync(context: SyncContext): AsyncGenerator<SyncPage, void, undefined>;
}
