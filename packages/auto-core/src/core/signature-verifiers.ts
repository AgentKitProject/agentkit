/**
 * Provider inbound-auth signature verifiers (event-driven expansion).
 *
 * Every comparison of attacker-presented material is CONSTANT-TIME: presented
 * and expected values are sha256-hashed first (so the compared buffers are
 * always equal length) and compared with `timingSafeEqual` — the same pattern
 * as the webhook secret verification (webhook-secret.ts).
 *
 * DETERMINISM: timestamp-window checks (`stripe`, `slack`) take `now` as an
 * ISO string option — never argless Date.
 *
 * SSRF: the SNS verifier validates the SigningCertURL host against
 * `^sns\.[a-z0-9-]+\.amazonaws\.com$` over https BEFORE any fetch, and
 * `extractSnsSubscribeConfirmation` applies the same gate to the SubscribeURL
 * (the caller — the app route — performs the confirmation fetch).
 *
 * SECRETS: plaintext HMAC signing secrets arrive here as parameters only (the
 * caller reveals them from the SecretStore); nothing is persisted (S2).
 */

import { createHash, createHmac, createVerify, timingSafeEqual } from "node:crypto";
import { verifyWebhookSecret } from "./webhook-secret.js";

// ---------------------------------------------------------------------------
// Constant-time compare
// ---------------------------------------------------------------------------

/**
 * Constant-time string equality: both sides are sha256-hashed so the compared
 * buffers are always the same length (timingSafeEqual never throws and the
 * compare cannot leak length or prefix information).
 */
function constantTimeStringEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/** Options for the timestamp-windowed verifiers (stripe/slack). */
export interface TimestampToleranceOptions {
  /** Maximum allowed |now - signed timestamp| in seconds. Default 300. */
  toleranceSec?: number;
  /** Clock — ISO 8601. Threaded; never argless Date. */
  now: string;
}

// ---------------------------------------------------------------------------
// GitHub (X-Hub-Signature-256)
// ---------------------------------------------------------------------------

/**
 * Verifies a GitHub webhook: `X-Hub-Signature-256: sha256=<hex hmac of body>`.
 */
export function verifyGithub(
  signature256Header: string | null | undefined,
  rawBody: string,
  secret: string,
): boolean {
  if (!signature256Header) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return constantTimeStringEqual(signature256Header.trim().toLowerCase(), expected);
}

// ---------------------------------------------------------------------------
// Stripe (Stripe-Signature)
// ---------------------------------------------------------------------------

/**
 * Verifies a Stripe webhook: `Stripe-Signature: t=<unix>,v1=<hex hmac>` where
 * the signed payload is `"{t}.{rawBody}"`. Rejects timestamps outside the
 * replay window (|now - t| > toleranceSec). Multiple v1 entries are accepted
 * (key rotation); each candidate is compared constant-time.
 */
export function verifyStripe(
  stripeSigHeader: string | null | undefined,
  rawBody: string,
  secret: string,
  opts: TimestampToleranceOptions,
): boolean {
  if (!stripeSigHeader) return false;
  const toleranceSec = opts.toleranceSec ?? 300;
  const nowMs = Date.parse(opts.now);
  if (!Number.isFinite(nowMs)) return false;
  const nowSec = Math.floor(nowMs / 1000);

  let timestamp: string | undefined;
  const v1: string[] = [];
  for (const part of stripeSigHeader.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t" && /^\d+$/.test(value)) timestamp = value;
    else if (key === "v1" && value.length > 0) v1.push(value);
  }
  if (timestamp === undefined || v1.length === 0) return false;
  if (Math.abs(nowSec - Number(timestamp)) > toleranceSec) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  return v1.some((sig) => constantTimeStringEqual(sig.toLowerCase(), expected));
}

// ---------------------------------------------------------------------------
// Slack (X-Slack-Request-Timestamp + X-Slack-Signature)
// ---------------------------------------------------------------------------

/**
 * Verifies a Slack request: signature `v0=<hex hmac of "v0:{ts}:{body}">`.
 * Rejects skewed timestamps (|now - ts| > toleranceSec — replay protection).
 */
export function verifySlack(
  tsHeader: string | null | undefined,
  sigHeader: string | null | undefined,
  rawBody: string,
  secret: string,
  opts: TimestampToleranceOptions,
): boolean {
  if (!tsHeader || !sigHeader) return false;
  const toleranceSec = opts.toleranceSec ?? 300;
  const ts = tsHeader.trim();
  if (!/^\d+$/.test(ts)) return false;
  const nowMs = Date.parse(opts.now);
  if (!Number.isFinite(nowMs)) return false;
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - Number(ts)) > toleranceSec) return false;

  const expected =
    "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`, "utf8").digest("hex");
  return constantTimeStringEqual(sigHeader.trim().toLowerCase(), expected);
}

// ---------------------------------------------------------------------------
// AWS SNS (SignatureVersion 1 / 2)
// ---------------------------------------------------------------------------

/** Valid SNS signing-cert / subscribe-confirmation host. */
const SNS_HOST_RE = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

/** The subset of an SNS message envelope the verifier reads. */
export interface SnsMessageFields {
  Type?: string;
  MessageId?: string;
  Token?: string;
  TopicArn?: string;
  Subject?: string;
  Message?: string;
  Timestamp?: string;
  SignatureVersion?: string;
  Signature?: string;
  SigningCertURL?: string;
  SubscribeURL?: string;
}

/** Minimal response shape the injected cert fetcher must return. */
export interface SnsCertFetchResponse {
  ok: boolean;
  text(): Promise<string>;
}

/** Injected fetch for the SNS signing certificate (never global fetch). */
export type SnsCertFetch = (url: string) => Promise<SnsCertFetchResponse>;

/**
 * True when `urlStr` is an https URL whose host is a genuine SNS endpoint
 * (`sns.<region>.amazonaws.com`) — the SSRF gate for SigningCertURL and
 * SubscribeURL. Suffix-spoof hosts (`sns.x.amazonaws.com.evil.com`) fail the
 * anchored regex.
 */
export function isValidSnsHost(urlStr: string | undefined): boolean {
  if (!urlStr) return false;
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return false;
  }
  return url.protocol === "https:" && SNS_HOST_RE.test(url.hostname);
}

/** Builds the canonical SNS string-to-sign per message Type (SignatureVersion
 *  1/2 sign the same canonical string; only the digest differs). */
function buildSnsStringToSign(m: SnsMessageFields): string | undefined {
  let fields: string[];
  if (m.Type === "Notification") {
    fields = ["Message", "MessageId"];
    if (m.Subject !== undefined) fields.push("Subject");
    fields.push("Timestamp", "TopicArn", "Type");
  } else if (m.Type === "SubscriptionConfirmation" || m.Type === "UnsubscribeConfirmation") {
    fields = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  } else {
    return undefined;
  }
  let out = "";
  for (const field of fields) {
    const value = (m as Record<string, unknown>)[field];
    if (typeof value !== "string") return undefined;
    out += `${field}\n${value}\n`;
  }
  return out;
}

/**
 * Verifies an SNS message signature (SignatureVersion "1" = SHA1withRSA,
 * "2" = SHA256withRSA). The SigningCertURL host MUST pass the SNS host gate
 * (https + `sns.<region>.amazonaws.com`) BEFORE any fetch; the certificate is
 * fetched via the INJECTED fetchImpl only. Returns false on any failure —
 * never throws.
 */
export async function verifySnsMessage(
  message: unknown,
  opts: { fetchImpl: SnsCertFetch },
): Promise<boolean> {
  if (message === null || typeof message !== "object") return false;
  const m = message as SnsMessageFields;
  if (typeof m.Signature !== "string" || typeof m.SigningCertURL !== "string") return false;

  // SSRF gate FIRST — no fetch unless the cert URL is a genuine SNS host.
  if (!isValidSnsHost(m.SigningCertURL)) return false;

  const stringToSign = buildSnsStringToSign(m);
  if (stringToSign === undefined) return false;

  const version = m.SignatureVersion ?? "1";
  const algorithm = version === "1" ? "RSA-SHA1" : version === "2" ? "RSA-SHA256" : undefined;
  if (algorithm === undefined) return false;

  let certPem: string;
  try {
    const res = await opts.fetchImpl(m.SigningCertURL);
    if (!res.ok) return false;
    certPem = await res.text();
  } catch {
    return false;
  }

  try {
    const verifier = createVerify(algorithm);
    verifier.update(stringToSign, "utf8");
    return verifier.verify(certPem, m.Signature, "base64");
  } catch {
    return false;
  }
}

/**
 * Returns the SubscribeURL of an SNS SubscriptionConfirmation ONLY when its
 * host passes the same SNS host gate (SSRF protection). The CALLER (the app
 * route) performs the confirmation fetch; this function only vets the URL.
 */
export function extractSnsSubscribeConfirmation(message: unknown): string | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const m = message as SnsMessageFields;
  if (m.Type !== "SubscriptionConfirmation") return undefined;
  if (typeof m.SubscribeURL !== "string") return undefined;
  return isValidSnsHost(m.SubscribeURL) ? m.SubscribeURL : undefined;
}

// ---------------------------------------------------------------------------
// EventSource bearer token
// ---------------------------------------------------------------------------

/**
 * Verifies a presented EventSource ingest bearer token against the stored
 * sha256 hex `tokenHash` — sha256 + constant-time, exactly the webhook secret
 * path (delegates to verifyWebhookSecret; same hash-then-compare mechanics).
 */
export function verifySourceToken(presented: string, tokenHash: string): boolean {
  return verifyWebhookSecret(presented, tokenHash);
}
