import { NextResponse } from "next/server";
import { LoginInput, login } from "@/server/auth/service";
import { SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";
import { readJson, route } from "@/server/http/handler";

export const runtime = "nodejs";

export const POST = route("auth.login", async (request) => {
  const input = LoginInput.parse(await readJson(request));
  const { cookie } = await login(input);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, cookie, sessionCookieOptions());
  return response;
});
