// M6 Slice 1 — the BROWSER preview route /api/market/licensed must never return
// the CONTENT of a PROTECTED (online-only, paid && !downloadable) kit. It returns
// the output-only run directive (HTTP 402) for protected kits, and the in-memory
// preview for downloadable ones. (Belt-and-suspenders: it classifies first and
// never fetches/builds the protected kit's bytes.)
import { describe, expect, it, vi, beforeEach } from "vitest";

// Auth: run the handler as an authed user without touching WorkOS.
vi.mock("@/lib/api", async () => {
  const { NextResponse } = await import("next/server");
  return {
    withUser: async (handler: (u: unknown) => Promise<unknown>) => {
      const result = await handler({ id: "user_1" });
      return result instanceof NextResponse ? result : NextResponse.json(result ?? { ok: true });
    },
    jsonError: (message: string, status: number) => NextResponse.json({ error: message }, { status })
  };
});

// Self-host links → public run targets (hosted behavior).
vi.mock("@/lib/self-host", () => ({
  getMarketBaseUrl: () => "https://market.agentkitproject.com",
  getEcosystemLinks: () => ({
    forgeUrl: "https://forge.agentkitproject.com",
    autoUrl: "https://auto.agentkitproject.com"
  })
}));

// A throwaway forwarding store.
vi.mock("@/server/core/import-ops", () => ({
  createForwardingStore: async () => ({ get: async () => null, set: async () => {}, clear: async () => {} })
}));

// The core market client: checkEntitlement classifies; fetchLicensedKit returns
// bytes (only ever reached for downloadable kits in this route).
const checkEntitlementMock = vi.fn();
const fetchLicensedKitMock = vi.fn();
vi.mock("@/server/core/load-core", () => ({
  loadCoreMarket: async () => ({
    checkEntitlement: (...a: unknown[]) => checkEntitlementMock(...a),
    fetchLicensedKit: (...a: unknown[]) => fetchLicensedKitMock(...a)
  })
}));

import { POST } from "@/app/api/market/licensed/route";

/** A real .agentkit.zip so buildInMemoryPreview works on the downloadable path. */
async function makeZip(): Promise<Uint8Array> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("agentkit.yaml", "name: DL Kit\nschemaVersion: '0.1'\n");
  zip.file("AGENTKIT.md", "# DL Kit body");
  return zip.generateAsync({ type: "uint8array" });
}

function req(body: unknown): Request {
  return new Request("http://localhost/api/market/licensed", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  checkEntitlementMock.mockReset();
  fetchLicensedKitMock.mockReset();
});

describe("/api/market/licensed (browser route) — M6 Slice 1", () => {
  it("PROTECTED (online-only) kit → 402 directive, NEVER content/preview", async () => {
    checkEntitlementMock.mockResolvedValue({
      slug: "paid-kit",
      kitId: "kit_protected",
      pricing: "paid",
      downloadable: false,
      onlineOnly: true,
      entitled: true
    });
    const res = await POST(req({ slug: "paid-kit" }));
    expect(res.status).toBe(402);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.onlineOnly).toBe(true);
    expect(json.code).toBe("online_only_run_required");
    expect((json.runTargets as Record<string, string>).forgeWebUrl).toBe("https://forge.agentkitproject.com");
    expect((json.runTargets as Record<string, string>).autoUrl).toBe("https://auto.agentkitproject.com");
    // The bytes were NEVER fetched and NO preview was built.
    expect(fetchLicensedKitMock).not.toHaveBeenCalled();
    expect(json.preview).toBeUndefined();
    // Moat: no watermark/pricing values in the directive.
    expect(JSON.stringify(json)).not.toContain("watermark");
    expect(JSON.stringify(json)).not.toContain("contentBase64");
  });

  it("DOWNLOADABLE paid kit → preview is returned", async () => {
    checkEntitlementMock.mockResolvedValue({
      slug: "dl-kit",
      kitId: "kit_dl",
      pricing: "paid",
      downloadable: true,
      onlineOnly: false,
      entitled: true
    });
    const bytes = await makeZip();
    fetchLicensedKitMock.mockResolvedValue({
      bytes,
      onlineOnly: false,
      pricing: "paid",
      downloadable: true,
      kitId: "kit_dl",
      fileName: "dl.agentkit.zip",
      sha256: "abc",
      licenseVersion: "default-v1",
      entitlementId: "ent_1"
    });
    const res = await POST(req({ slug: "dl-kit" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.onlineOnly).toBe(false);
    expect(fetchLicensedKitMock).toHaveBeenCalledOnce();
    const preview = json.preview as { files: string[]; texts: Record<string, string> };
    expect(preview.files).toContain("agentkit.yaml");
    expect(preview.texts["AGENTKIT.md"]).toContain("DL Kit body");
  });
});
