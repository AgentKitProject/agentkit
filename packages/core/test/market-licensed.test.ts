import { describe, expect, test } from "vitest";

import { fetchLicensedKit, isOnlineOnly } from "../src/market/licensed.js";
import { sha256Hex } from "../src/market/upload.js";
import type { FetchLike, FetchLikeResponse } from "../src/market/http.js";
import type { StoredSession, TokenStore } from "../src/market/types.js";

// A non-expired unsigned JWT so `ensureAccessToken` never tries to refresh
// (we never verify the signature here — only the `exp` claim is decoded).
function makeJwt(expSecondsFromNow: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: "user_1", exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })
  ).toString("base64url");
  return `${header}.${payload}.`;
}

const VALID_ACCESS_TOKEN = makeJwt(3600);

function memoryStore(): TokenStore {
  let session: StoredSession | null = {
    accessToken: VALID_ACCESS_TOKEN,
    refreshToken: "test-refresh",
    connectedAt: new Date().toISOString()
  };
  return {
    async get() {
      return session;
    },
    async set(next) {
      session = next;
    },
    async clear() {
      session = null;
    }
  };
}

function jsonResponse(status: number, body: unknown): FetchLikeResponse {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return text;
    },
    async json() {
      return body;
    },
    async arrayBuffer() {
      return new TextEncoder().encode(text).buffer;
    }
  };
}

// A trivial valid-looking zip payload; checksum is computed over these bytes.
const PACKAGE_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const PACKAGE_B64 = Buffer.from(PACKAGE_BYTES).toString("base64");
const PACKAGE_SHA = sha256Hex(PACKAGE_BYTES);

describe("isOnlineOnly", () => {
  test("paid + not downloadable => online-only", () => {
    expect(isOnlineOnly("paid", false)).toBe(true);
    expect(isOnlineOnly("paid", undefined)).toBe(true);
  });
  test("paid + downloadable => not online-only", () => {
    expect(isOnlineOnly("paid", true)).toBe(false);
  });
  test("free => never online-only", () => {
    expect(isOnlineOnly("free", false)).toBe(false);
  });
});

describe("fetchLicensedKit", () => {
  test("returns in-memory bytes, attaches bearer, flags online-only", async () => {
    let sawAuth = "";
    let calledPath = "";
    const fetchImpl: FetchLike = async (input, init) => {
      calledPath = input;
      sawAuth = init?.headers?.Authorization ?? "";
      return jsonResponse(200, {
        kitId: "kit_123",
        userId: "user_1",
        entitlementId: "ent_1",
        fileName: "cool.agentkit.zip",
        contentBase64: PACKAGE_B64,
        sha256: PACKAGE_SHA,
        licenseVersion: "default-v1",
        watermark: { entitlementId: "ent_1", userId: "user_1", kitId: "kit_123", grantedAt: "now", hash: "abc" },
        pricing: "paid",
        downloadable: false,
        onlineOnly: true
      });
    };

    const result = await fetchLicensedKit(memoryStore(), {
      slug: "cool-kit",
      clientId: "client_x",
      fetch: fetchImpl
    });

    expect(calledPath).toContain("/api/forge/kits/cool-kit/licensed-package");
    expect(sawAuth).toBe(`Bearer ${VALID_ACCESS_TOKEN}`);
    expect(result.bytes).toEqual(PACKAGE_BYTES);
    expect(result.sha256).toBe(PACKAGE_SHA);
    expect(result.onlineOnly).toBe(true);
    expect(result.pricing).toBe("paid");
    expect(result.downloadable).toBe(false);
    expect(result.watermark?.hash).toBe("abc");
  });

  test("downloadable paid kit is not online-only", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(200, {
        kitId: "kit_dl",
        fileName: "dl.agentkit.zip",
        contentBase64: PACKAGE_B64,
        sha256: PACKAGE_SHA,
        licenseVersion: "default-v1",
        pricing: "paid",
        downloadable: true,
        onlineOnly: false
      });
    const result = await fetchLicensedKit(memoryStore(), { slug: "dl-kit", clientId: "c", fetch: fetchImpl });
    expect(result.onlineOnly).toBe(false);
    expect(result.downloadable).toBe(true);
  });

  test("403 surfaces an entitlement error", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(403, { message: "You do not have an active entitlement for this kit." });
    await expect(
      fetchLicensedKit(memoryStore(), { slug: "x", clientId: "c", fetch: fetchImpl })
    ).rejects.toThrow(/entitlement/i);
  });

  test("402 surfaces a payment-coming-soon error", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(402, { message: "Payment is coming soon." });
    await expect(
      fetchLicensedKit(memoryStore(), { slug: "x", clientId: "c", fetch: fetchImpl })
    ).rejects.toThrow(/payment/i);
  });

  test("checksum mismatch is rejected", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(200, {
        kitId: "k",
        fileName: "k.agentkit.zip",
        contentBase64: PACKAGE_B64,
        sha256: "deadbeef",
        licenseVersion: "v",
        pricing: "paid",
        downloadable: false
      });
    await expect(
      fetchLicensedKit(memoryStore(), { slug: "x", clientId: "c", fetch: fetchImpl })
    ).rejects.toThrow(/checksum/i);
  });
});
