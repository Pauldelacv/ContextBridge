import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuthContext } from "@/server/auth/current";
import { forbidden, validationFailed } from "@/server/errors";
import { readJson, route } from "@/server/http/handler";
import { getIntegration, isIntegrationProvider } from "@/server/integrations/registry";
import { encodeOAuthState } from "@/server/integrations/service";

export const runtime = "nodejs";

const ConnectInput = z.object({ provider: z.string() });

/** Starts OAuth: returns the provider URL for the browser to follow. */
export const POST = route("integrations.connect", async (request) => {
  const auth = await requireAuthContext();
  if (auth.role === "member") throw forbidden("Only owners and admins can connect data sources");

  const { provider } = ConnectInput.parse(await readJson(request));
  if (!isIntegrationProvider(provider)) throw validationFailed(`Unknown provider: ${provider}`);

  const integration = getIntegration(provider);
  if (!integration.isConfigured()) {
    throw validationFailed(
      `${integration.displayName} is not configured on this deployment. Set its client id and secret first.`,
    );
  }

  const state = encodeOAuthState(auth.organizationId, provider);
  return NextResponse.json({ authorizationUrl: integration.buildAuthorizationUrl(state) });
});
