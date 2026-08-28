import { requireAuthContext } from "@/server/auth/current";
import { forbidden, validationFailed } from "@/server/errors";
import { route } from "@/server/http/handler";
import { disconnectIntegration } from "@/server/integrations/service";

export const runtime = "nodejs";

export const POST = route("integrations.disconnect", async (request) => {
  const auth = await requireAuthContext();
  if (auth.role === "member") throw forbidden("Only owners and admins can disconnect data sources");

  const integrationId = new URL(request.url).pathname.split("/").at(-2);
  if (!integrationId) throw validationFailed("Missing integration id");

  await disconnectIntegration(auth.organizationId, integrationId);
  return { ok: true };
});
