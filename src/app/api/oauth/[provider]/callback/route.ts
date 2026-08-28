import { NextResponse } from "next/server";
import { getEnv } from "@/server/config/env";
import { forbidden, validationFailed } from "@/server/errors";
import { route } from "@/server/http/handler";
import { isIntegrationProvider } from "@/server/integrations/registry";
import { connectIntegration, decodeOAuthState } from "@/server/integrations/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OAuth callback, shared by every provider.
 *
 * The tenant comes from the signed `state`, never from the session — the user
 * arrives here via a provider redirect, and trusting anything else would let
 * one organization attach a connection to another.
 */
export const GET = route("oauth.callback", async (request) => {
  const url = new URL(request.url);
  const provider = url.pathname.split("/").at(-2) ?? "";
  const settingsUrl = `${getEnv().APP_URL}/sources`;

  if (!isIntegrationProvider(provider)) throw validationFailed(`Unknown provider: ${provider}`);

  // The user declined on the provider's consent screen.
  const denied = url.searchParams.get("error");
  if (denied) {
    return NextResponse.redirect(`${settingsUrl}?error=${encodeURIComponent(denied)}`);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw validationFailed("Missing OAuth code or state");

  const payload = decodeOAuthState(state);
  if (payload.provider !== provider) throw forbidden("OAuth state does not match this provider");

  await connectIntegration(payload.organizationId, provider, code);
  return NextResponse.redirect(`${settingsUrl}?connected=${provider}`);
});
