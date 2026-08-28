import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { getEnv } from "@/server/config/env";
import { getDb } from "@/server/db/client";
import { documents, integrations } from "@/server/db/schema";
import type { Integration, IntegrationProvider } from "@/server/db/schema";
import { forbidden, notFound, validationFailed } from "@/server/errors";
import { encryptCredentials } from "@/server/integrations/credentials";
import { getIntegration, isIntegrationProvider, listIntegrations } from "@/server/integrations/registry";
import { buildIdempotencyKey, enqueueJob } from "@/server/jobs/queue";
import { logger } from "@/server/logging/logger";

/** OAuth state is valid for ten minutes — long enough to consent, short enough to matter. */
const STATE_TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  organizationId: string;
  provider: IntegrationProvider;
  issuedAt: number;
  nonce: string;
}

/**
 * Signed, self-contained OAuth state.
 *
 * It carries the organization through the redirect so the callback knows which
 * tenant to attach the connection to, and the HMAC is what stops an attacker
 * pointing a callback at someone else's organization.
 */
export function encodeOAuthState(organizationId: string, provider: IntegrationProvider): string {
  const payload: StatePayload = {
    organizationId,
    provider,
    issuedAt: Date.now(),
    nonce: randomBytes(12).toString("base64url"),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", getEnv().SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function decodeOAuthState(state: string): StatePayload {
  const [body, signature] = state.split(".");
  if (!body || !signature) throw validationFailed("Malformed OAuth state");

  const expected = Buffer.from(
    createHmac("sha256", getEnv().SESSION_SECRET).update(body).digest("base64url"),
  );
  const provided = Buffer.from(signature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw forbidden("OAuth state signature is invalid");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
  if (Date.now() - payload.issuedAt > STATE_TTL_MS) {
    throw validationFailed("This authorization link has expired — please try connecting again");
  }
  if (!isIntegrationProvider(payload.provider)) throw validationFailed("Unknown provider in OAuth state");

  return payload;
}

export interface IntegrationSummary {
  provider: IntegrationProvider;
  displayName: string;
  description: string;
  configured: boolean;
  supportsIncrementalSync: boolean;
  connection: {
    id: string;
    displayName: string;
    status: Integration["status"];
    lastSyncedAt: Date | null;
    lastError: string | null;
    documentCount: number;
  } | null;
}

/** The catalogue the dashboard renders: every provider, connected or not. */
export async function listIntegrationSummaries(organizationId: string): Promise<IntegrationSummary[]> {
  const db = getDb();

  const connections = await db
    .select()
    .from(integrations)
    .where(eq(integrations.organizationId, organizationId))
    .orderBy(desc(integrations.createdAt));

  // One grouped query rather than one per connection.
  const countRows = await db
    .select({ integrationId: documents.integrationId, total: count() })
    .from(documents)
    .where(and(eq(documents.organizationId, organizationId), isNull(documents.deletedAt)))
    .groupBy(documents.integrationId);
  const counts = new Map(countRows.map((row) => [row.integrationId, row.total]));

  return listIntegrations().map((integration) => {
    const connection = connections.find((row) => row.provider === integration.provider) ?? null;
    return {
      provider: integration.provider,
      displayName: integration.displayName,
      description: integration.description,
      configured: integration.isConfigured(),
      supportsIncrementalSync: integration.supportsIncrementalSync,
      connection: connection
        ? {
            id: connection.id,
            displayName: connection.displayName,
            status: connection.status,
            lastSyncedAt: connection.lastSyncedAt,
            lastError: connection.lastError,
            documentCount: counts.get(connection.id) ?? 0,
          }
        : null,
    };
  });
}

/**
 * Stores a completed OAuth connection and kicks off the first full sync.
 *
 * Reconnecting the same workspace updates the existing row rather than
 * creating a second one, so a re-auth does not orphan the documents already
 * ingested under that integration.
 */
export async function connectIntegration(
  organizationId: string,
  provider: IntegrationProvider,
  code: string,
): Promise<Integration> {
  const integration = getIntegration(provider);
  const connection = await integration.completeAuthorization(code);

  const [record] = await getDb()
    .insert(integrations)
    .values({
      organizationId,
      provider,
      externalAccountId: connection.externalAccountId,
      displayName: connection.displayName,
      status: "connected",
      credentials: encryptCredentials(connection.credentials),
      config: connection.config ?? {},
      cursor: {},
      lastError: null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [integrations.organizationId, integrations.provider, integrations.externalAccountId],
      set: {
        displayName: connection.displayName,
        status: "connected",
        credentials: encryptCredentials(connection.credentials),
        config: connection.config ?? {},
        lastError: null,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!record) throw validationFailed("Could not store the integration");

  await requestSync(organizationId, record.id, "full");
  logger.info("integration.connected", { organizationId, provider, integrationId: record.id });
  return record;
}

/** Enqueues a sync. Repeated calls while one is queued collapse to a single job. */
export async function requestSync(
  organizationId: string,
  integrationId: string,
  mode: "full" | "incremental",
): Promise<{ queued: boolean }> {
  const db = getDb();

  const [record] = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(and(eq(integrations.id, integrationId), eq(integrations.organizationId, organizationId)))
    .limit(1);
  if (!record) throw notFound("Integration not found");

  const { deduplicated } = await enqueueJob({
    organizationId,
    integrationId,
    type: mode === "full" ? "integration.full_sync" : "integration.incremental_sync",
    idempotencyKey: buildIdempotencyKey(["sync", integrationId, mode]),
  });

  return { queued: !deduplicated };
}

/**
 * Disconnects a source and removes what it contributed.
 *
 * Cascading the documents is deliberate: a customer who disconnects Notion
 * expects their Notion content to stop being searchable, not to linger.
 */
export async function disconnectIntegration(
  organizationId: string,
  integrationId: string,
): Promise<void> {
  const db = getDb();

  const [record] = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(and(eq(integrations.id, integrationId), eq(integrations.organizationId, organizationId)))
    .limit(1);
  if (!record) throw notFound("Integration not found");

  await db.transaction(async (tx) => {
    // chunks.document_id cascades on delete, so dropping this integration's
    // documents takes its chunks with them — and only its chunks.
    await tx.delete(documents).where(eq(documents.integrationId, integrationId));
    await tx.delete(integrations).where(eq(integrations.id, integrationId));
  });

  logger.info("integration.disconnected", { organizationId, integrationId });
}

/** Finds the organization behind an inbound webhook or slash command. */
export async function findIntegrationByExternalAccount(
  provider: IntegrationProvider,
  externalAccountId: string,
): Promise<Integration | null> {
  const [record] = await getDb()
    .select()
    .from(integrations)
    .where(
      and(eq(integrations.provider, provider), eq(integrations.externalAccountId, externalAccountId)),
    )
    .limit(1);
  return record ?? null;
}
