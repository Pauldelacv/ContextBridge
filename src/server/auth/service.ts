import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { memberships, organizations, users } from "@/server/db/schema";
import { conflict, unauthenticated, validationFailed } from "@/server/errors";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { createSession } from "@/server/auth/session";

export const SignupInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z.string().min(10, "Password must be at least 10 characters").max(200),
  organizationName: z.string().trim().min(1, "Organization name is required").max(120),
});
export type SignupInput = z.infer<typeof SignupInput>;

export const LoginInput = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});
export type LoginInput = z.infer<typeof LoginInput>;

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "org"
  );
}

async function uniqueSlug(base: string): Promise<string> {
  const db = getDb();
  for (let suffix = 0; suffix < 50; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    const [existing] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, candidate))
      .limit(1);
    if (!existing) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Signing up creates the user, their organization and the owner membership as
 * one transaction — a user without a tenant is not a valid state in this app.
 */
export async function signup(input: SignupInput): Promise<{ cookie: string; organizationId: string }> {
  const db = getDb();

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);
  if (existing) throw conflict("An account with that email already exists");

  const passwordHash = await hashPassword(input.password);
  const slug = await uniqueSlug(slugify(input.organizationName));

  const { userId, organizationId } = await db.transaction(async (tx) => {
    const [organization] = await tx
      .insert(organizations)
      .values({ name: input.organizationName, slug })
      .returning({ id: organizations.id });
    const [user] = await tx
      .insert(users)
      .values({ name: input.name, email: input.email, passwordHash })
      .returning({ id: users.id });

    if (!organization || !user) throw validationFailed("Could not create the account");

    await tx
      .insert(memberships)
      .values({ organizationId: organization.id, userId: user.id, role: "owner" });

    return { userId: user.id, organizationId: organization.id };
  });

  return { cookie: await createSession(userId, organizationId), organizationId };
}

export async function login(input: LoginInput): Promise<{ cookie: string }> {
  const db = getDb();

  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);

  // Same message either way: do not reveal whether the email exists.
  const invalid = unauthenticated("Incorrect email or password");
  if (!user) throw invalid;
  if (!(await verifyPassword(input.password, user.passwordHash))) throw invalid;

  const [membership] = await db
    .select({ organizationId: memberships.organizationId })
    .from(memberships)
    .where(eq(memberships.userId, user.id))
    .limit(1);
  if (!membership) throw unauthenticated("This account has no organization");

  return { cookie: await createSession(user.id, membership.organizationId) };
}

/** Switching orgs re-checks membership; the session is the only place org is stored. */
export async function assertMembership(userId: string, organizationId: string): Promise<void> {
  const [membership] = await getDb()
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId)))
    .limit(1);
  if (!membership) throw unauthenticated("You are not a member of that organization");
}
