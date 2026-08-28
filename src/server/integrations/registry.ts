import { notFound } from "@/server/errors";
import type { IntegrationProvider } from "@/server/db/schema";
import type { SourceIntegration } from "@/server/integrations/types";
import { notionIntegration } from "@/server/integrations/notion";
import { googleDriveIntegration } from "@/server/integrations/google-drive";
import { slackIntegration } from "@/server/integrations/slack";

/**
 * The only place that knows which providers exist. Adding a source is one
 * entry here plus its own directory — no other module changes.
 */
const REGISTRY: Record<IntegrationProvider, SourceIntegration> = {
  notion: notionIntegration,
  google_drive: googleDriveIntegration,
  slack: slackIntegration,
};

export function getIntegration(provider: IntegrationProvider): SourceIntegration {
  const integration = REGISTRY[provider];
  if (!integration) throw notFound(`Unknown integration provider: ${provider}`);
  return integration;
}

export function listIntegrations(): SourceIntegration[] {
  return Object.values(REGISTRY);
}

export function isIntegrationProvider(value: string): value is IntegrationProvider {
  return value in REGISTRY;
}
