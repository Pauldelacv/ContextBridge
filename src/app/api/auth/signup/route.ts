import { NextResponse } from "next/server";
import { SignupInput, signup } from "@/server/auth/service";
import { SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";
import { readJson, route } from "@/server/http/handler";

export const runtime = "nodejs";

export const POST = route("auth.signup", async (request) => {
  const input = SignupInput.parse(await readJson(request));
  const { cookie } = await signup(input);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, cookie, sessionCookieOptions());
  return response;
});
