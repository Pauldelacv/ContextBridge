import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { getEnv } from "@/server/config/env";
import { getDb } from "@/server/db/client";
import { memberships, organizations, sessions, users } from "@/server/db/schema";
import type { MembershipRole } from "@/server/db/schema";

export const SESSION_COOKIE = "cb_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

/**
 * The cookie value is `<id>.<hmac>`. The HMAC means a forged or tampered id is
 * rejected before it ever reaches the database.
 */
function sign(id: string): string {
  return createHmac("sha256", getEnv().SESSION_SECRET).update(id).digest("base64url");
}

export function encodeSessionCookie(id: string): string {
  return `${id}.${sign(id)}`;
}

export function decodeSessionCookie(value: string | undefined): string | null {
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;

  const id = value.slice(0, separator);
  const provided = Buffer.from(value.slice(separator + 1));
  const expected = Buffer.from(sign(id));
  if (provided.length !== expected.length) return null;
  return timingSafeEqual(provided, expected) ? id : null;
}

export interface AuthContext {
  userId: string;
  userName: string;
  userEmail: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: MembershipRole;
  sessionId: string;
}

export async function createSession(userId: string, organizationId: string): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  await getDb()
    .insert(sessions)
    .values({
      id,
      userId,
      organizationId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
  return encodeSessionCookie(id);
}

/**
 * Resolves a cookie to the full tenant context in one query. Re-reading the
 * membership on every request (rather than trusting the cookie) means access
 * revoked in the UI takes effect immediately.
 */
export async function resolveSession(cookieValue: string | undefined): Promise<AuthContext | null> {
  const sessionId = decodeSessionCookie(cookieValue);
  if (!sessionId) return null;

  const [row] = await getDb()
    .select({
      sessionId: sessions.id,
      userId: users.id,
      userName: users.name,
      userEmail: users.email,
      organizationId: organizations.id,
      organizationName: organizations.name,
      organizationSlug: organizations.slug,
      role: memberships.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(organizations, eq(organizations.id, sessions.organizationId))
    .innerJoin(
      memberships,
      and(
        eq(memberships.userId, sessions.userId),
        eq(memberships.organizationId, sessions.organizationId),
      ),
    )
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date())))
    .limit(1);

  return row ?? null;
}

export async function destroySession(cookieValue: string | undefined): Promise<void> {
  const sessionId = decodeSessionCookie(cookieValue);
  if (!sessionId) return;
  await getDb().delete(sessions).where(eq(sessions.id, sessionId));
}

export async function purgeExpiredSessions(): Promise<number> {
  const deleted = await getDb()
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id });
  return deleted.length;
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: getEnv().NODE_ENV === "production",
  maxAge: SESSION_TTL_MS / 1000,
} as const;
