import { describe, expect, test, vi } from "vitest";
import {
  forgeMarketRoutes,
  publicKitDetailResponseSchema
} from "@agentkitforge/contracts";

import { checkKitUpdate } from "../src/market/update.js";
import { normalizeVersionToInt } from "../src/package/version.js";
import type { FetchLike, FetchLikeResponse } from "../src/market/http.js";

const BASE = "https://market.agentkitproject.com";

function jsonResponse(status: number, body: unknown): FetchLikeResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0)
  };
}

/**
 * Public kit-detail body matching market-infra `toPublicKitDetail`.
 *
 * Built to satisfy `publicKitDetailResponseSchema` from
 * `@agentkitforge/contracts` so these stubs exercise the same envelope the
 * production endpoint returns (and that `checkKitUpdate` now validates).
 */
function detail(currentVersion: string | null, latestVersion?: string | null) {
  const body = {
    item: {
      kitId: "kit_1",
      slug: "demo",
      name: "Demo Kit",
      summary: "A demo kit",
      currentVersion,
      latestVersion:
        latestVersion === undefined ? null : { version: latestVersion }
    }
  };
  // Contract guard: every stub must match the published schema shape.
  expect(publicKitDetailResponseSchema.safeParse(body).success).toBe(true);
  return body;
}

describe("checkKitUpdate", () => {
  test("newer latest published version => updateAvailable true", async () => {
    const fetchStub: FetchLike = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, detail("3")));
    const status = await checkKitUpdate({
      marketBaseUrl: BASE,
      slug: "demo",
      installedVersion: "2",
      fetch: fetchStub
    });
    expect(status).toEqual({
      available: true,
      latestVersion: "3",
      updateAvailable: true,
      reason: "ok"
    });
  });

  test("equal version => no update", async () => {
    const fetchStub: FetchLike = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, detail("2")));
    const status = await checkKitUpdate({
      marketBaseUrl: BASE,
      slug: "demo",
      installedVersion: "2",
      fetch: fetchStub
    });
    expect(status.available).toBe(true);
    expect(status.updateAvailable).toBe(false);
    expect(status.latestVersion).toBe("2");
    expect(status.reason).toBe("ok");
  });

  test("older latest than installed => no update", async () => {
    const fetchStub: FetchLike = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, detail("1")));
    const status = await checkKitUpdate({
      marketBaseUrl: BASE,
      slug: "demo",
      installedVersion: "5",
      fetch: fetchStub
    });
    expect(status.updateAvailable).toBe(false);
    expect(status.latestVersion).toBe("1");
  });

  test("legacy-semver installed (treated as 1), latest '2' => update", async () => {
    const fetchStub: FetchLike = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, detail("2")));
    const status = await checkKitUpdate({
      marketBaseUrl: BASE,
      slug: "demo",
      installedVersion: "0.1.0",
      fetch: fetchStub
    });
    expect(status.updateAvailable).toBe(true);
    expect(status.latestVersion).toBe("2");
  });

  test("falls back to latestVersion.version when currentVersion null", async () => {
    const fetchStub: FetchLike = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, detail(null, "4")));
    const status = await checkKitUpdate({
      marketBaseUrl: BASE,
      slug: "demo",
      installedVersion: "1",
      fetch: fetchStub
    });
    expect(status.available).toBe(true);
    expect(status.latestVersion).toBe("4");
    expect(status.updateAvailable).toBe(true);
  });

  test("200 with no published version => unavailable", async () => {
    const fetchStub: FetchLike = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, detail(null, undefined)));
    const status = await checkKitUpdate({
      marketBaseUrl: BASE,
      slug: "demo",
      installedVersion: "1",
      fetch: fetchStub
    });
    expect(status).toEqual({
      available: false,
      updateAvailable: false,
      reason: "unavailable"
    });
  });

  test("404 => not_found, not available", async () => {
    const fetchStub: FetchLike = vi
      .fn()
      .mockResolvedValue(jsonResponse(404, { message: "Kit not found" }));
    const status = await checkKitUpdate({
      marketBaseUrl: BASE,
      slug: "gone",
      installedVersion: "1",
      fetch: fetchStub
    });
    expect(status).toEqual({
      available: false,
      updateAvailable: false,
      reason: "not_found"
    });
  });

  test("network error => reason error, does NOT throw", async () => {
    const fetchStub: FetchLike = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED"));
    const status = await checkKitUpdate({
      marketBaseUrl: BASE,
      slug: "demo",
      installedVersion: "1",
      fetch: fetchStub
    });
    expect(status).toEqual({
      available: false,
      updateAvailable: false,
      reason: "error"
    });
  });

  test("non-404 server error => reason error", async () => {
    const fetchStub: FetchLike = vi
      .fn()
      .mockResolvedValue(jsonResponse(500, { message: "boom" }));
    const status = await checkKitUpdate({
      marketBaseUrl: BASE,
      slug: "demo",
      installedVersion: "1",
      fetch: fetchStub
    });
    expect(status.reason).toBe("error");
    expect(status.available).toBe(false);
  });

  test("malformed JSON => reason error", async () => {
    const bad: FetchLikeResponse = {
      status: 200,
      ok: true,
      text: async () => "not json",
      json: async () => {
        throw new Error("invalid json");
      },
      arrayBuffer: async () => new ArrayBuffer(0)
    };
    const status = await checkKitUpdate({
      marketBaseUrl: BASE,
      slug: "demo",
      installedVersion: "1",
      fetch: vi.fn().mockResolvedValue(bad)
    });
    expect(status.reason).toBe("error");
  });

  test("200 with body failing the contract schema => reason error", async () => {
    // Valid JSON but missing required PublicKitDetail fields (name/summary).
    const fetchStub: FetchLike = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { item: { kitId: "k", slug: "s", currentVersion: "3" } })
      );
    const status = await checkKitUpdate({
      marketBaseUrl: BASE,
      slug: "demo",
      installedVersion: "1",
      fetch: fetchStub
    });
    expect(status).toEqual({
      available: false,
      updateAvailable: false,
      reason: "error"
    });
  });

  test("GETs the tokenless public proxy route forgeMarketRoutes.kitDetail", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(200, detail("1")));
    await checkKitUpdate({
      marketBaseUrl: BASE,
      slug: "demo-kit",
      installedVersion: "1",
      fetch: fetchStub as unknown as FetchLike
    });
    const [url, init] = fetchStub.mock.calls[0];
    // Asserts the contract path, not a hand-written string.
    expect(forgeMarketRoutes.kitDetail("demo-kit")).toBe(
      "/api/forge/kits/demo-kit"
    );
    expect(url).toBe(`${BASE}${forgeMarketRoutes.kitDetail("demo-kit")}`);
    expect(init?.method).toBe("GET");
    expect(init?.headers).toBeUndefined();
  });

  test("accepts a full Market URL as slug input", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(200, detail("2")));
    const status = await checkKitUpdate({
      marketBaseUrl: BASE,
      slug: `${BASE}/kits/demo`,
      installedVersion: "1",
      fetch: fetchStub as unknown as FetchLike
    });
    expect(status.updateAvailable).toBe(true);
    expect(fetchStub.mock.calls[0][0]).toBe(
      `${BASE}${forgeMarketRoutes.kitDetail("demo")}`
    );
  });
});

describe("normalizeVersionToInt", () => {
  test("integer strings pass through", () => {
    expect(normalizeVersionToInt("1")).toBe(1);
    expect(normalizeVersionToInt("42")).toBe(42);
  });
  test("legacy / invalid => 1", () => {
    expect(normalizeVersionToInt("0.1.0")).toBe(1);
    expect(normalizeVersionToInt("")).toBe(1);
    expect(normalizeVersionToInt("0")).toBe(1);
    expect(normalizeVersionToInt(undefined)).toBe(1);
    expect(normalizeVersionToInt("abc")).toBe(1);
  });
  test("integer numbers pass through", () => {
    expect(normalizeVersionToInt(7)).toBe(7);
  });
});
