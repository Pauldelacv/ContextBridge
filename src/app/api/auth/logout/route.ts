import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, destroySession } from "@/server/auth/session";
import { route } from "@/server/http/handler";

export const runtime = "nodejs";

export const POST = route("auth.logout", async () => {
  const store = await cookies();
  await destroySession(store.get(SESSION_COOKIE)?.value);

  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE);
  return response;
});
