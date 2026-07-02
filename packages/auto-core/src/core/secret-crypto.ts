/**
 * SecretStore crypto (event-driven expansion — S2 invariant).
 *
 * Provider HMAC signing secrets must be RECOVERABLE (verifiers need the
 * plaintext), unlike our own bearer tokens (stored as hashes). Both persistent
 * SecretStore adapters encrypt with AES-256-GCM using a single operator key
 * from the AUTO_SECRET_ENCRYPTION_KEY env var (32 bytes, base64 or hex).
 *
 * SELF-HOST-SAFE DEFAULT: when the key is unset, the store throws a typed
 * SecretStoreUnconfiguredError — the web layer maps it to a clear 400 on a
 * signing-secret write, and sources WITHOUT signing secrets are unaffected.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Env var carrying the 32-byte (base64 or hex) SecretStore encryption key. */
export const AUTO_SECRET_KEY_ENV_VAR = "AUTO_SECRET_ENCRYPTION_KEY";

/** Thrown when secret storage is used without a (valid) configured key. */
export class SecretStoreUnconfiguredError extends Error {
  constructor(
    message = "Signing-secret storage is not configured on this instance (set AUTO_SECRET_ENCRYPTION_KEY to a 32-byte base64 or hex key).",
  ) {
    super(message);
    this.name = "SecretStoreUnconfiguredError";
  }
}

/**
 * Loads + validates the encryption key from the environment. Accepts base64
 * or hex encodings of EXACTLY 32 bytes; anything else throws the typed
 * unconfigured error (an invalid key must fail loudly, never half-work).
 */
export function loadSecretEncryptionKey(
  env: Record<string, string | undefined> = process.env,
): Buffer {
  const raw = env[AUTO_SECRET_KEY_ENV_VAR]?.trim();
  if (!raw) throw new SecretStoreUnconfiguredError();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    /* fall through to the typed error */
  }
  throw new SecretStoreUnconfiguredError();
}

/** One encrypted secret (all parts base64). */
export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
}

/** AES-256-GCM encrypt (random 12-byte IV per secret). */
export function encryptSecret(key: Buffer, plaintext: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/** AES-256-GCM decrypt; throws on a wrong key / tampered ciphertext. */
export function decryptSecret(key: Buffer, secret: EncryptedSecret): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(secret.iv, "base64"));
  decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
