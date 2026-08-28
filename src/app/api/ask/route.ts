import { requireAuthContext } from "@/server/auth/current";
import { readJson, route } from "@/server/http/handler";
import { AskInput, ask } from "@/server/retrieval/ask";

export const runtime = "nodejs";
// Retrieval + generation is always dynamic; never serve a cached answer.
export const dynamic = "force-dynamic";

export const POST = route("ask", async (request) => {
  const auth = await requireAuthContext();
  const input = AskInput.parse(await readJson(request));

  return ask(input, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    surface: "web",
  });
});
