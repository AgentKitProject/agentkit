/**
 * At-rest secret encryption for Profile org shared LLM API keys.
 *
 * AES-256-GCM with an `enc:v1:` envelope, ported VERBATIM from
 * agentkitmarket-core's `core/crypto.ts`. The ONLY difference is the env var:
 * the secret is read from `PROFILE_KEY_ENCRYPTION_SECRET` (mirrors
 * `MARKET_KEY_ENCRYPTION_SECRET` semantics exactly — hex/64, base64/32, or any
 * string hashed to 32 bytes).
 *
 * Local-first / self-host degrade: when the secret is unset, values are stored
 * in PLAINTEXT (and a one-time warning is logged) so an operator can stand the
 * service up without first provisioning a key. Set the secret to enable
 * encryption at rest. Encryption/decryption happens in the handler layer; the
 * store adapters only ever see the opaque ciphertext string.
 */

import crypto from "node:crypto";

let warnedNoSecret = false;

export function secretKey(): Buffer | null {
  const raw = process.env.PROFILE_KEY_ENCRYPTION_SECRET;
  if (!raw) {
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[profile-web] PROFILE_KEY_ENCRYPTION_SECRET is not set — org API keys are stored in PLAINTEXT. Set it to enable AES-256-GCM at-rest encryption.",
      );
    }
    return null;
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === 32) return b64;
  return crypto.createHash("sha256").update(raw).digest();
}

const ENC_PREFIX = "enc:v1:";

export function encryptSecret(plain: string): string {
  const key = secretKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  const key = secretKey();
  if (!key) throw new Error("Stored API key is encrypted but PROFILE_KEY_ENCRYPTION_SECRET is not set.");
  const [, , ivB64, tagB64, dataB64] = stored.split(":");
  const iv = Buffer.from(ivB64 ?? "", "base64");
  const tag = Buffer.from(tagB64 ?? "", "base64");
  const data = Buffer.from(dataB64 ?? "", "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
