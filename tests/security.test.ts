import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { closeDb, getDb } from "@/server/db/client";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { login, signup } from "@/server/auth/service";
import { decodeSessionCookie, encodeSessionCookie, resolveSession } from "@/server/auth/session";
import { decryptCredentials, encryptCredentials } from "@/server/integrations/credentials";
import { decodeOAuthState, encodeOAuthState } from "@/server/integrations/service";
import { verifySlackSignature } from "@/server/slack/verify";
import { resetDatabase } from "./helpers/db";

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const stored = await hashPassword("correct-horse-battery");
    expect(await verifyPassword("correct-horse-battery", stored)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("correct-horse-battery");
    expect(await verifyPassword("Correct-horse-battery", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("salts, so the same password hashes differently every time", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("rejects a malformed or truncated stored hash instead of throwing", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$aa$bb")).toBe(false);
    expect(await verifyPassword("x", "scrypt$deadbeef$00")).toBe(false);
  });
});

describe("credential encryption", () => {
  it("round-trips a credential envelope", () => {
    const secret = { accessToken: "secret-token", refreshToken: "refresh-token" };
    const restored = decryptCredentials<typeof secret>(encryptCredentials(secret));
    expect(restored).toEqual(secret);
  });

  it("does not store the plaintext anywhere in the envelope", () => {
    const envelope = encryptCredentials({ accessToken: "super-secret-value" });
    expect(JSON.stringify(envelope)).not.toContain("super-secret-value");
  });

  it("uses a fresh IV, so identical credentials produce different ciphertext", () => {
    const a = encryptCredentials({ accessToken: "same" });
    const b = encryptCredentials({ accessToken: "same" });
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("refuses to decrypt tampered ciphertext", () => {
    const envelope = encryptCredentials({ accessToken: "secret-token" });
    const flipped = Buffer.from(envelope.ciphertext, "base64");
    flipped[0] = flipped[0]! ^ 0xff;

    expect(() =>
      decryptCredentials({ ...envelope, ciphertext: flipped.toString("base64") }),
    ).toThrow();
  });
});

describe("session cookies", () => {
  it("round-trips a signed session id", () => {
    const cookie = encodeSessionCookie("session-id-123");
    expect(decodeSessionCookie(cookie)).toBe("session-id-123");
  });

  it("rejects a forged or tampered cookie", () => {
    expect(decodeSessionCookie("session-id-123.not-a-real-signature")).toBeNull();
    expect(decodeSessionCookie("no-separator")).toBeNull();
    expect(decodeSessionCookie(undefined)).toBeNull();

    const cookie = encodeSessionCookie("session-id-123");
    const [, signature] = cookie.split(".");
    // Same signature, different id: must not authenticate.
    expect(decodeSessionCookie(`other-id.${signature}`)).toBeNull();
  });
});

describe("OAuth state", () => {
  it("round-trips the organization and provider", () => {
    const state = encodeOAuthState("11111111-1111-1111-1111-111111111111", "notion");
    const payload = decodeOAuthState(state);

    expect(payload.organizationId).toBe("11111111-1111-1111-1111-111111111111");
    expect(payload.provider).toBe("notion");
  });

  it("rejects state whose signature does not match", () => {
    const state = encodeOAuthState("11111111-1111-1111-1111-111111111111", "notion");
    const [body] = state.split(".");
    expect(() => decodeOAuthState(`${body}.forged-signature`)).toThrow();
  });

  it("rejects a re-pointed organization id", () => {
    // An attacker swapping the payload for another tenant's id must fail.
    const forged = Buffer.from(
      JSON.stringify({
        organizationId: "22222222-2222-2222-2222-222222222222",
        provider: "notion",
        issuedAt: Date.now(),
        nonce: "x",
      }),
    ).toString("base64url");
    const stolenSignature = encodeOAuthState("11111111-1111-1111-1111-111111111111", "notion")
      .split(".")
      .at(-1);

    expect(() => decodeOAuthState(`${forged}.${stolenSignature}`)).toThrow();
  });
});

describe("Slack signature verification", () => {
  const secret = "slack-signing-secret";
  const body = "token=abc&team_id=T1&text=hello";

  function sign(timestamp: string, withSecret = secret): string {
    return `v0=${createHmac("sha256", withSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  }

  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = secret;
    // The env module memoises; reset it so the new secret is picked up.
    void import("@/server/config/env").then((module) => module.resetEnvCache());
  });

  it("accepts a correctly signed, fresh request", async () => {
    const { resetEnvCache } = await import("@/server/config/env");
    resetEnvCache();

    const now = Date.now();
    const timestamp = String(Math.floor(now / 1000));
    expect(() => verifySlackSignature(body, sign(timestamp), timestamp, now)).not.toThrow();
  });

  it("rejects a signature made with the wrong secret", async () => {
    const { resetEnvCache } = await import("@/server/config/env");
    resetEnvCache();

    const now = Date.now();
    const timestamp = String(Math.floor(now / 1000));
    expect(() =>
      verifySlackSignature(body, sign(timestamp, "wrong-secret"), timestamp, now),
    ).toThrow();
  });

  it("rejects a replayed request outside the timestamp window", async () => {
    const { resetEnvCache } = await import("@/server/config/env");
    resetEnvCache();

    const now = Date.now();
    const stale = String(Math.floor(now / 1000) - 60 * 10);
    // Correctly signed, but ten minutes old.
    expect(() => verifySlackSignature(body, sign(stale), stale, now)).toThrow();
  });

  it("rejects missing headers and malformed timestamps", async () => {
    const { resetEnvCache } = await import("@/server/config/env");
    resetEnvCache();

    const now = Date.now();
    const timestamp = String(Math.floor(now / 1000));
    expect(() => verifySlackSignature(body, null, timestamp, now)).toThrow();
    expect(() => verifySlackSignature(body, sign(timestamp), null, now)).toThrow();
    expect(() => verifySlackSignature(body, sign(timestamp), "not-a-number", now)).toThrow();
  });

  it("rejects a signature that does not cover this body", async () => {
    const { resetEnvCache } = await import("@/server/config/env");
    resetEnvCache();

    const now = Date.now();
    const timestamp = String(Math.floor(now / 1000));
    expect(() =>
      verifySlackSignature("token=abc&team_id=T1&text=evil", sign(timestamp), timestamp, now),
    ).toThrow();
  });
});

describe("signup and login", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("creates a user, an organization and an owner membership together", async () => {
    const { cookie, organizationId } = await signup({
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: "analytical-engine-1843",
      organizationName: "Analytical Engines",
    });

    const context = await resolveSession(cookie);
    expect(context).not.toBeNull();
    expect(context!.organizationId).toBe(organizationId);
    expect(context!.role).toBe("owner");
    expect(context!.organizationName).toBe("Analytical Engines");
  });

  it("rejects a duplicate email", async () => {
    const input = {
      name: "Ada",
      email: "ada@example.com",
      password: "analytical-engine-1843",
      organizationName: "Engines",
    };
    await signup(input);
    await expect(signup({ ...input, organizationName: "Other" })).rejects.toThrow(/already exists/);
  });

  it("gives two organizations distinct slugs when their names collide", async () => {
    const first = await signup({
      name: "A",
      email: "a@example.com",
      password: "password-long-enough",
      organizationName: "Acme",
    });
    const second = await signup({
      name: "B",
      email: "b@example.com",
      password: "password-long-enough",
      organizationName: "Acme",
    });

    expect(first.organizationId).not.toBe(second.organizationId);

    const contexts = await Promise.all([
      resolveSession(first.cookie),
      resolveSession(second.cookie),
    ]);
    expect(contexts[0]!.organizationSlug).not.toBe(contexts[1]!.organizationSlug);
  });

  it("logs in with the right password and refuses the wrong one", async () => {
    await signup({
      name: "Ada",
      email: "ada@example.com",
      password: "analytical-engine-1843",
      organizationName: "Engines",
    });

    const { cookie } = await login({ email: "ada@example.com", password: "analytical-engine-1843" });
    expect(await resolveSession(cookie)).not.toBeNull();

    await expect(login({ email: "ada@example.com", password: "wrong" })).rejects.toThrow();
  });

  it("does not reveal whether an email exists", async () => {
    await signup({
      name: "Ada",
      email: "ada@example.com",
      password: "analytical-engine-1843",
      organizationName: "Engines",
    });

    const unknown = await login({ email: "nobody@example.com", password: "x" }).catch(
      (error: Error) => error.message,
    );
    const wrongPassword = await login({ email: "ada@example.com", password: "x" }).catch(
      (error: Error) => error.message,
    );

    expect(unknown).toBe(wrongPassword);
  });

  it("rejects an expired session", async () => {
    const { cookie } = await signup({
      name: "Ada",
      email: "ada@example.com",
      password: "analytical-engine-1843",
      organizationName: "Engines",
    });

    const { sessions } = await import("@/server/db/schema");
    await getDb().update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });

    expect(await resolveSession(cookie)).toBeNull();
  });

  it("stops resolving a session once the membership is revoked", async () => {
    const { cookie } = await signup({
      name: "Ada",
      email: "ada@example.com",
      password: "analytical-engine-1843",
      organizationName: "Engines",
    });
    expect(await resolveSession(cookie)).not.toBeNull();

    // Membership is re-checked per request, so revocation takes effect at once.
    const { memberships } = await import("@/server/db/schema");
    await getDb().delete(memberships);

    expect(await resolveSession(cookie)).toBeNull();
  });
});
