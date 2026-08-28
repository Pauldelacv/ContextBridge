import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/server/config/env";
import { forbidden, validationFailed } from "@/server/errors";

/** Slack rejects its own replays past five minutes; so do we. */
const MAX_SKEW_SECONDS = 60 * 5;

/**
 * Verifies Slack's request signature.
 *
 * The endpoint is public, so this is the only thing standing between the
 * internet and a tenant's knowledge base. Two properties matter: the
 * timestamp check bounds replay, and the comparison is constant-time so the
 * signature cannot be recovered a byte at a time.
 */
export function verifySlackSignature(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  now: number = Date.now(),
): void {
  const signingSecret = getEnv().SLACK_SIGNING_SECRET;
  if (!signingSecret) throw validationFailed("Slack is not configured on this deployment");
  if (!signature || !timestamp) throw forbidden("Missing Slack signature headers");

  const requestedAt = Number(timestamp);
  if (!Number.isFinite(requestedAt)) throw forbidden("Malformed Slack timestamp");
  if (Math.abs(now / 1000 - requestedAt) > MAX_SKEW_SECONDS) {
    throw forbidden("Slack request timestamp is outside the accepted window");
  }

  const expected = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;

  const provided = Buffer.from(signature);
  const computed = Buffer.from(expected);
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    throw forbidden("Slack signature verification failed");
  }
}
