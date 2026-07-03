/**
 * Provider signature-verifier tests: happy path + tampered body + skewed
 * timestamps per provider, SNS host-validation SSRF rejections (evil
 * SigningCertURL / SubscribeURL), and source-token verification.
 */

import { createHmac, createSign, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  extractSnsSubscribeConfirmation,
  isValidSnsHost,
  verifyDiscord,
  verifyGithub,
  verifySlack,
  verifySnsMessage,
  verifySourceToken,
  verifyStripe,
  verifyTelegram,
  type SnsCertFetch,
} from "../src/core/signature-verifiers.js";
import { hashWebhookSecret } from "../src/core/webhook-secret.js";

const NOW = "2026-06-18T00:00:00.000Z";
const NOW_SEC = Math.floor(Date.parse(NOW) / 1000);

describe("verifyGithub", () => {
  const secret = "gh-secret";
  const body = '{"action":"opened"}';
  const sig = "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");

  it("accepts a valid signature", () => {
    expect(verifyGithub(sig, body, secret)).toBe(true);
  });

  it("accepts an uppercase-hex header (case-insensitive)", () => {
    expect(verifyGithub(sig.toUpperCase().replace("SHA256", "sha256"), body, secret)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifyGithub(sig, body + "x", secret)).toBe(false);
  });

  it("rejects a wrong secret and a missing/malformed header", () => {
    expect(verifyGithub(sig, body, "other")).toBe(false);
    expect(verifyGithub(undefined, body, secret)).toBe(false);
    expect(verifyGithub("", body, secret)).toBe(false);
    expect(verifyGithub("sha1=deadbeef", body, secret)).toBe(false);
  });
});

describe("verifyStripe", () => {
  const secret = "whsec_test";
  const body = '{"id":"evt_1"}';

  function stripeHeader(tSec: number, sigBody = body, sigSecret = secret): string {
    const v1 = createHmac("sha256", sigSecret).update(`${tSec}.${sigBody}`, "utf8").digest("hex");
    return `t=${tSec},v1=${v1}`;
  }

  it("accepts a valid, in-window signature", () => {
    expect(verifyStripe(stripeHeader(NOW_SEC - 10), body, secret, { now: NOW })).toBe(true);
  });

  it("accepts multiple v1 entries when one matches (key rotation)", () => {
    const good = stripeHeader(NOW_SEC);
    const header = `t=${NOW_SEC},v1=${"0".repeat(64)},${good.split(",")[1]}`;
    expect(verifyStripe(header, body, secret, { now: NOW })).toBe(true);
  });

  it("rejects a tampered body and a wrong secret", () => {
    expect(verifyStripe(stripeHeader(NOW_SEC), body + "x", secret, { now: NOW })).toBe(false);
    expect(verifyStripe(stripeHeader(NOW_SEC), body, "other", { now: NOW })).toBe(false);
  });

  it("rejects timestamps outside the replay window (both directions)", () => {
    expect(verifyStripe(stripeHeader(NOW_SEC - 301), body, secret, { now: NOW })).toBe(false);
    expect(verifyStripe(stripeHeader(NOW_SEC + 301), body, secret, { now: NOW })).toBe(false);
    // Boundary + custom tolerance.
    expect(verifyStripe(stripeHeader(NOW_SEC - 300), body, secret, { now: NOW })).toBe(true);
    expect(
      verifyStripe(stripeHeader(NOW_SEC - 100), body, secret, { now: NOW, toleranceSec: 60 }),
    ).toBe(false);
  });

  it("rejects malformed headers", () => {
    expect(verifyStripe(undefined, body, secret, { now: NOW })).toBe(false);
    expect(verifyStripe("v1=abc", body, secret, { now: NOW })).toBe(false);
    expect(verifyStripe(`t=${NOW_SEC}`, body, secret, { now: NOW })).toBe(false);
    expect(verifyStripe("t=notanumber,v1=abc", body, secret, { now: NOW })).toBe(false);
  });
});

describe("verifySlack", () => {
  const secret = "slack-signing";
  const body = "payload=%7B%7D";

  function slackSig(ts: string, sigBody = body, sigSecret = secret): string {
    return "v0=" + createHmac("sha256", sigSecret).update(`v0:${ts}:${sigBody}`, "utf8").digest("hex");
  }

  it("accepts a valid, in-window signature", () => {
    const ts = String(NOW_SEC - 5);
    expect(verifySlack(ts, slackSig(ts), body, secret, { now: NOW })).toBe(true);
  });

  it("rejects a tampered body and wrong secret", () => {
    const ts = String(NOW_SEC);
    expect(verifySlack(ts, slackSig(ts), body + "x", secret, { now: NOW })).toBe(false);
    expect(verifySlack(ts, slackSig(ts), body, "other", { now: NOW })).toBe(false);
  });

  it("rejects skewed timestamps (replay protection)", () => {
    const old = String(NOW_SEC - 301);
    expect(verifySlack(old, slackSig(old), body, secret, { now: NOW })).toBe(false);
    const future = String(NOW_SEC + 301);
    expect(verifySlack(future, slackSig(future), body, secret, { now: NOW })).toBe(false);
  });

  it("rejects missing/malformed headers", () => {
    expect(verifySlack(undefined, slackSig(String(NOW_SEC)), body, secret, { now: NOW })).toBe(false);
    expect(verifySlack(String(NOW_SEC), undefined, body, secret, { now: NOW })).toBe(false);
    expect(verifySlack("not-a-ts", "v0=abc", body, secret, { now: NOW })).toBe(false);
  });
});

describe("SNS verification", () => {
  // createVerify accepts a public-key PEM in place of an x509 cert, so the
  // tests sign with a generated RSA key and "serve" the public key.
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem";

  function signSns(fields: string[][], algorithm: "RSA-SHA1" | "RSA-SHA256"): string {
    const stringToSign = fields.map(([k, v]) => `${k}\n${v}\n`).join("");
    const signer = createSign(algorithm);
    signer.update(stringToSign, "utf8");
    return signer.sign(privateKey, "base64");
  }

  function notification(over: Record<string, unknown> = {}): Record<string, unknown> {
    const base = {
      Type: "Notification",
      MessageId: "mid-1",
      TopicArn: "arn:aws:sns:us-east-1:123:topic",
      Message: "hello",
      Timestamp: "2026-06-18T00:00:00.000Z",
      SignatureVersion: "1",
      SigningCertURL: CERT_URL,
    };
    const merged = { ...base, ...over } as Record<string, unknown>;
    if (merged.Signature === undefined) {
      merged.Signature = signSns(
        [
          ["Message", String(merged.Message)],
          ["MessageId", String(merged.MessageId)],
          ["Timestamp", String(merged.Timestamp)],
          ["TopicArn", String(merged.TopicArn)],
          ["Type", String(merged.Type)],
        ],
        merged.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1",
      );
    }
    return merged;
  }

  function fetchServing(pem: string): { fetchImpl: SnsCertFetch; calls: string[] } {
    const calls: string[] = [];
    const fetchImpl: SnsCertFetch = async (url) => {
      calls.push(url);
      return { ok: true, text: async () => pem };
    };
    return { fetchImpl, calls };
  }

  it("verifies a SignatureVersion 1 (SHA1) notification", async () => {
    const { fetchImpl, calls } = fetchServing(publicPem);
    expect(await verifySnsMessage(notification(), { fetchImpl })).toBe(true);
    expect(calls).toEqual([CERT_URL]);
  });

  it("verifies a SignatureVersion 2 (SHA256) notification", async () => {
    const { fetchImpl } = fetchServing(publicPem);
    expect(await verifySnsMessage(notification({ SignatureVersion: "2" }), { fetchImpl })).toBe(true);
  });

  it("verifies a SubscriptionConfirmation string-to-sign", async () => {
    const subscribeUrl = "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t1";
    const msg: Record<string, unknown> = {
      Type: "SubscriptionConfirmation",
      MessageId: "mid-2",
      Token: "t1",
      TopicArn: "arn:aws:sns:us-east-1:123:topic",
      Message: "confirm it",
      SubscribeURL: subscribeUrl,
      Timestamp: "2026-06-18T00:00:00.000Z",
      SignatureVersion: "1",
      SigningCertURL: CERT_URL,
    };
    msg.Signature = signSns(
      [
        ["Message", "confirm it"],
        ["MessageId", "mid-2"],
        ["SubscribeURL", subscribeUrl],
        ["Timestamp", "2026-06-18T00:00:00.000Z"],
        ["Token", "t1"],
        ["TopicArn", "arn:aws:sns:us-east-1:123:topic"],
        ["Type", "SubscriptionConfirmation"],
      ],
      "RSA-SHA1",
    );
    const { fetchImpl } = fetchServing(publicPem);
    expect(await verifySnsMessage(msg, { fetchImpl })).toBe(true);
  });

  it("rejects a tampered message", async () => {
    const { fetchImpl } = fetchServing(publicPem);
    const msg = notification();
    msg.Message = "tampered";
    expect(await verifySnsMessage(msg, { fetchImpl })).toBe(false);
  });

  it("rejects evil SigningCertURLs BEFORE any fetch (SSRF gate)", async () => {
    const evil = [
      "https://evil.com/cert.pem",
      "http://sns.us-east-1.amazonaws.com/cert.pem", // not https
      "https://sns.us-east-1.amazonaws.com.evil.com/cert.pem", // suffix spoof
      "https://xsns.us-east-1.amazonaws.com/cert.pem",
      "https://sns.us-east-1.amazonaws.com:8443@evil.com/cert.pem",
      "not a url",
    ];
    for (const url of evil) {
      const { fetchImpl, calls } = fetchServing(publicPem);
      expect(await verifySnsMessage(notification({ SigningCertURL: url }), { fetchImpl })).toBe(false);
      expect(calls).toEqual([]); // never fetched
    }
  });

  it("rejects unknown SignatureVersions, bad types, and fetch failures", async () => {
    const { fetchImpl } = fetchServing(publicPem);
    expect(await verifySnsMessage(notification({ SignatureVersion: "3" }), { fetchImpl })).toBe(false);
    expect(await verifySnsMessage(notification({ Type: "Other" }), { fetchImpl })).toBe(false);
    expect(await verifySnsMessage(null, { fetchImpl })).toBe(false);
    expect(await verifySnsMessage("string", { fetchImpl })).toBe(false);
    const failing: SnsCertFetch = async () => ({ ok: false, text: async () => "" });
    expect(await verifySnsMessage(notification(), { fetchImpl: failing })).toBe(false);
    const throwing: SnsCertFetch = async () => {
      throw new Error("net down");
    };
    expect(await verifySnsMessage(notification(), { fetchImpl: throwing })).toBe(false);
    // Garbage cert content → false, not a throw.
    const garbage: SnsCertFetch = async () => ({ ok: true, text: async () => "not a pem" });
    expect(await verifySnsMessage(notification(), { fetchImpl: garbage })).toBe(false);
  });

  it("extractSnsSubscribeConfirmation gates the SubscribeURL host (SSRF)", () => {
    const good = "https://sns.eu-west-2.amazonaws.com/?Action=ConfirmSubscription";
    expect(
      extractSnsSubscribeConfirmation({ Type: "SubscriptionConfirmation", SubscribeURL: good }),
    ).toBe(good);
    for (const evil of [
      "https://evil.com/?Action=ConfirmSubscription",
      "http://sns.eu-west-2.amazonaws.com/x", // not https
      "https://sns.eu-west-2.amazonaws.com.evil.com/x",
    ]) {
      expect(
        extractSnsSubscribeConfirmation({ Type: "SubscriptionConfirmation", SubscribeURL: evil }),
      ).toBeUndefined();
    }
    expect(
      extractSnsSubscribeConfirmation({ Type: "Notification", SubscribeURL: good }),
    ).toBeUndefined();
    expect(extractSnsSubscribeConfirmation(null)).toBeUndefined();
  });

  it("isValidSnsHost anchors the host pattern", () => {
    expect(isValidSnsHost("https://sns.ap-southeast-2.amazonaws.com/x.pem")).toBe(true);
    expect(isValidSnsHost("https://sns.amazonaws.com/x.pem")).toBe(false); // no region
    expect(isValidSnsHost(undefined)).toBe(false);
  });
});

describe("verifySourceToken", () => {
  it("accepts the matching token (sha256 + constant-time) and rejects others", () => {
    const token = "ingest-token-123";
    const hash = hashWebhookSecret(token);
    expect(verifySourceToken(token, hash)).toBe(true);
    expect(verifySourceToken("wrong", hash)).toBe(false);
    expect(verifySourceToken("", hash)).toBe(false);
    // Malformed stored hash never throws.
    expect(verifySourceToken(token, "short")).toBe(false);
  });
});

describe("verifyTelegram (Wave 4)", () => {
  it("accepts the exact secret token (constant-time compare)", () => {
    expect(verifyTelegram("tg-secret-token", "tg-secret-token")).toBe(true);
    expect(verifyTelegram("  tg-secret-token  ", "tg-secret-token")).toBe(true); // trimmed
  });

  it("rejects a wrong/missing header and an empty expected token", () => {
    expect(verifyTelegram("wrong", "tg-secret-token")).toBe(false);
    expect(verifyTelegram(null, "tg-secret-token")).toBe(false);
    expect(verifyTelegram(undefined, "tg-secret-token")).toBe(false);
    expect(verifyTelegram("", "tg-secret-token")).toBe(false);
    // Empty expected token must NEVER verify (unconfigured = reject).
    expect(verifyTelegram("", "")).toBe(false);
    expect(verifyTelegram("anything", "")).toBe(false);
  });
});

describe("verifyDiscord (Wave 4 — ed25519)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex");
  const timestamp = String(NOW_SEC);
  const body = JSON.stringify({ type: 1 });
  const signature = cryptoSign(
    null,
    Buffer.from(timestamp + body, "utf8"),
    privateKey,
  ).toString("hex");

  it("accepts a valid ed25519 signature over timestamp+body", () => {
    expect(verifyDiscord(signature, timestamp, body, publicKeyHex)).toBe(true);
  });

  it("rejects a tampered body / timestamp / signature", () => {
    expect(verifyDiscord(signature, timestamp, body + "x", publicKeyHex)).toBe(false);
    expect(verifyDiscord(signature, timestamp + "1", body, publicKeyHex)).toBe(false);
    const flipped = (signature[0] === "0" ? "1" : "0") + signature.slice(1);
    expect(verifyDiscord(flipped, timestamp, body, publicKeyHex)).toBe(false);
  });

  it("rejects the wrong key, malformed hex, and missing headers — never throws", () => {
    const other = generateKeyPairSync("ed25519")
      .publicKey.export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("hex");
    expect(verifyDiscord(signature, timestamp, body, other)).toBe(false);
    expect(verifyDiscord("zz".repeat(64), timestamp, body, publicKeyHex)).toBe(false);
    expect(verifyDiscord(signature, timestamp, body, "not-hex")).toBe(false);
    expect(verifyDiscord(null, timestamp, body, publicKeyHex)).toBe(false);
    expect(verifyDiscord(signature, null, body, publicKeyHex)).toBe(false);
  });
});
