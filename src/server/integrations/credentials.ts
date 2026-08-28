import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getEnv } from "@/server/config/env";

export interface EncryptedEnvelope {
  iv: string;
  tag: string;
  ciphertext: string;
}

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

/** Derives a stable 32-byte key from the configured secret of arbitrary length. */
function key(): Buffer {
  return createHash("sha256").update(getEnv().CREDENTIAL_SECRET).digest();
}

/**
 * OAuth access and refresh tokens are the keys to a customer's Notion
 * workspace or Google Drive. They are encrypted at rest with AES-256-GCM so a
 * database dump alone does not hand an attacker every tenant's data source.
 * GCM is authenticated: tampering with the ciphertext fails decryption rather
 * than yielding garbage.
 */
export function encryptCredentials(value: unknown): EncryptedEnvelope {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptCredentials<T>(envelope: EncryptedEnvelope): T {
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
