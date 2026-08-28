import { requireAuthContext } from "@/server/auth/current";
import { forbidden, validationFailed } from "@/server/errors";
import { readJson, route } from "@/server/http/handler";
import { requestSync } from "@/server/integrations/service";
import { z } from "zod";

export const runtime = "nodejs";

const SyncInput = z.object({ mode: z.enum(["full", "incremental"]).default("incremental") });

export const POST = route("integrations.sync", async (request) => {
  const auth = await requireAuthContext();
  if (auth.role === "member") throw forbidden("Only owners and admins can trigger a sync");

  const integrationId = new URL(request.url).pathname.split("/").at(-2);
  if (!integrationId) throw validationFailed("Missing integration id");

  const body = await readJson(request).catch(() => ({}));
  const { mode } = SyncInput.parse(body ?? {});

  // requestSync scopes the lookup to the caller's organization, so an id from
  // another tenant resolves to "not found" rather than syncing their source.
  return requestSync(auth.organizationId, integrationId, mode);
});
