import { cookies } from "next/headers";
import type { AuthContext } from "@/server/auth/session";
import { SESSION_COOKIE, resolveSession } from "@/server/auth/session";
import { unauthenticated } from "@/server/errors";

/** Current session, or null. Use in layouts/pages that render for guests too. */
export async function getAuthContext(): Promise<AuthContext | null> {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value);
}

/** Current session, or throw. Use in anything behind the app shell. */
export async function requireAuthContext(): Promise<AuthContext> {
  const context = await getAuthContext();
  if (!context) throw unauthenticated();
  return context;
}
