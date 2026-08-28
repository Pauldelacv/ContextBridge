import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/**
 * Every embedding stored in `chunks.embedding` must have exactly this many
 * dimensions — pgvector indexes are dimension-bound, so the number is a
 * schema-level contract every embedding provider has to satisfy.
 */
export const EMBEDDING_DIMENSIONS = 1536;

/** Tenant boundary. Every non-global row hangs off an organization. */
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("organizations_slug_key").on(table.slug)],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_email_key").on(table.email)],
);

export type MembershipRole = "owner" | "admin" | "member";

/** A user belongs to one or more organizations; the role gates admin actions. */
export const memberships = pgTable(
  "memberships",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<MembershipRole>().notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    index("memberships_user_idx").on(table.userId),
  ],
);

/**
 * Server-side sessions. The cookie holds an opaque signed id, never user data,
 * so revoking a session is a delete rather than a token-blacklist problem.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The organization this session is currently acting as. */
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

export type IntegrationProvider = "notion" | "google_drive" | "slack";
export type IntegrationStatus = "connected" | "syncing" | "error" | "disconnected";

/**
 * One connected third-party account for one organization.
 *
 * `credentials` holds an encrypted envelope (see `server/integrations/credentials.ts`);
 * `cursor` holds provider-specific incremental-sync state (Notion's last-edited
 * watermark, Drive's `startPageToken`, Slack's per-channel timestamps).
 */
export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").$type<IntegrationProvider>().notNull(),
    /** Provider-side account/workspace/team id — used to route inbound webhooks. */
    externalAccountId: text("external_account_id").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status").$type<IntegrationStatus>().notNull().default("connected"),
    credentials: jsonb("credentials").$type<{ iv: string; tag: string; ciphertext: string }>().notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    cursor: jsonb("cursor").$type<Record<string, unknown>>().notNull().default({}),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One connection per provider account per org — reconnecting updates in place.
    uniqueIndex("integrations_org_provider_account_key").on(
      table.organizationId,
      table.provider,
      table.externalAccountId,
    ),
    index("integrations_org_idx").on(table.organizationId),
    index("integrations_provider_account_idx").on(table.provider, table.externalAccountId),
  ],
);

/**
 * A normalized document from any provider. `contentHash` is what makes
 * re-ingestion idempotent: unchanged content skips embedding entirely.
 */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    provider: text("provider").$type<IntegrationProvider>().notNull(),
    /** Stable id in the source system (Notion page id, Drive file id, Slack thread key). */
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    url: text("url"),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    /** Author/space/labels — carried into retrieval as filterable metadata. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
    /** Soft delete: a document removed upstream stops being retrievable but keeps its audit trail. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("documents_integration_external_key").on(table.integrationId, table.externalId),
    index("documents_org_idx").on(table.organizationId),
    index("documents_org_provider_idx").on(table.organizationId, table.provider),
  ],
);

/** An embedded slice of a document. Retrieval works over these, never whole documents. */
export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** Position within the document, so retrieved context can be re-ordered readably. */
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    tokenEstimate: integer("token_estimate").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    /** Which model produced `embedding` — a model change invalidates the vector, not the chunk. */
    embeddingModel: text("embedding_model"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chunks_document_ordinal_key").on(table.documentId, table.ordinal),
    index("chunks_org_idx").on(table.organizationId),
    // HNSW + cosine: the vector index the retrieval layer actually queries.
    index("chunks_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);

export type SyncJobStatus = "pending" | "running" | "succeeded" | "failed" | "dead";
export type SyncJobType =
  | "integration.full_sync"
  | "integration.incremental_sync"
  | "document.ingest"
  | "document.delete";

/**
 * Postgres-backed job queue. Claiming uses `FOR UPDATE SKIP LOCKED`, so several
 * workers can share the table without a broker (ADR 0003).
 */
export const syncJobs = pgTable(
  "sync_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id").references(() => integrations.id, { onDelete: "cascade" }),
    type: text("type").$type<SyncJobType>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<SyncJobStatus>().notNull().default("pending"),
    /**
     * Deduplicates enqueues: re-delivering the same webhook, or a manual sync
     * fired twice, collapses onto one pending job.
     */
    idempotencyKey: text("idempotency_key").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("sync_jobs_idempotency_key").on(table.idempotencyKey),
    index("sync_jobs_claim_idx").on(table.status, table.runAt),
    index("sync_jobs_org_idx").on(table.organizationId, table.createdAt),
  ],
);

/** Query log — powers the dashboard's recent-questions view and answer-quality review. */
export const queryLogs = pgTable(
  "query_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** "web" or "slack" — which interface asked. */
    surface: text("surface").notNull(),
    question: text("question").notNull(),
    answer: text("answer"),
    citations: jsonb("citations").$type<unknown[]>().notNull().default([]),
    retrievedChunkIds: jsonb("retrieved_chunk_ids").$type<string[]>().notNull().default([]),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("query_logs_org_idx").on(table.organizationId, table.createdAt)],
);

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Integration = typeof integrations.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type Chunk = typeof chunks.$inferSelect;
export type SyncJob = typeof syncJobs.$inferSelect;
export type QueryLog = typeof queryLogs.$inferSelect;
