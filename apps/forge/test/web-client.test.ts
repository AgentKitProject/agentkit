// Verifies the WebForgeClient maps ForgeClient methods to the right HTTP
// endpoints/verbs/bodies, and that desktop-only seams degrade as documented.
import { describe, expect, it, vi } from "vitest";
import { HttpError, NotAvailableOnWebError, WebForgeClient } from "@/forge-client/web-client";

type Call = { url: string; init?: RequestInit };

function makeClient(responder: (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const r = responder({ url, init });
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    return new Response(body, {
      status: r.status ?? 200,
      headers: r.headers ?? { "content-type": "application/json" }
    });
  });
  const downloads: { name: string }[] = [];
  const client = new WebForgeClient({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    download: (_d, name) => downloads.push({ name })
  });
  return { client, calls, downloads, fetchImpl };
}

describe("WebForgeClient endpoint mapping", () => {
  it("listMyKits GETs /api/kits with credentials", async () => {
    const { client, calls } = makeClient(() => ({ body: { kits: [{ kitId: "k1" }] } }));
    const kits = await client.listMyKits();
    expect(kits).toEqual([{ kitId: "k1" }]);
    expect(calls[0].url).toBe("/api/kits");
    expect(calls[0].init?.credentials).toBe("include");
  });

  it("createAgentKitFromTemplate POSTs /api/kits/from-template", async () => {
    const { client, calls } = makeClient(() => ({ body: { kit: { kitId: "new" } } }));
    const res = await client.createAgentKitFromTemplate({ template: "blank", id: "i", name: "n", description: "d" });
    expect(res.kitId).toBe("new");
    expect(calls[0].url).toBe("/api/kits/from-template");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ template: "blank", id: "i" });
  });

  it("validateAgentKit POSTs /api/kits/:id/validate using rootPath as kitId", async () => {
    const { client, calls } = makeClient(() => ({ body: { report: { valid: true } } }));
    const report = await client.validateAgentKit({ rootPath: "kit 1", profile: "publishable" });
    expect(report.valid).toBe(true);
    expect(calls[0].url).toBe("/api/kits/kit%201/validate");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ profile: "publishable" });
  });

  it("packageAgentKit downloads zip bytes from /package", async () => {
    const { client, calls, downloads } = makeClient(() => ({
      body: "PK",
      headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="my-kit.agentkit.zip"' }
    }));
    const res = await client.packageAgentKit({ rootPath: "k1", outputFolder: "" });
    expect(calls[0].url).toBe("/api/kits/k1/package");
    expect(res.fileName).toBe("my-kit.agentkit.zip");
    expect(downloads[0].name).toBe("my-kit.agentkit.zip");
  });

  it("exportAgentKitOneFile downloads returned text", async () => {
    const { client, calls, downloads } = makeClient(() => ({ body: { text: "# kit", fileName: "kit.md" } }));
    const res = await client.exportAgentKitOneFile({ rootPath: "k1", outputPath: "" });
    expect(calls[0].url).toBe("/api/kits/k1/export/onefile");
    expect(res.text).toBe("# kit");
    expect(downloads[0].name).toBe("kit.md");
  });

  it("importHostedMarketKit POSTs /api/import/market", async () => {
    const { client, calls } = makeClient(() => ({ body: { kitId: "imported" } }));
    await client.importHostedMarketKit({ slug: "s", marketBaseUrl: "", validationProfile: "local-valid" });
    expect(calls[0].url).toBe("/api/import/market");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ slug: "s" });
  });

  it("fetchLicensedMarketKit POSTs /api/market/licensed", async () => {
    const { client, calls } = makeClient(() => ({ body: { onlineOnly: true, preview: { files: [], texts: {} } } }));
    const res = await client.fetchLicensedMarketKit({ slug: "s", marketBaseUrl: "", validationProfile: "local-valid" });
    expect(res.onlineOnly).toBe(true);
    expect(calls[0].url).toBe("/api/market/licensed");
  });

  it("removeKitFromLibrary DELETEs /api/kits/:id", async () => {
    const { client, calls } = makeClient(() => ({ body: { ok: true } }));
    await client.removeKitFromLibrary("k1");
    expect(calls[0].url).toBe("/api/kits/k1");
    expect(calls[0].init?.method).toBe("DELETE");
  });

  it("surfaces server error envelopes", async () => {
    const { client } = makeClient(() => ({ status: 400, body: { error: "boom" } }));
    await expect(client.listMyKits()).rejects.toThrow("boom");
  });

  it("desktop-only seams throw NotAvailableOnWebError", async () => {
    const { client } = makeClient(() => ({ body: {} }));
    expect(() => client.addKitToLibrary()).toThrow(NotAvailableOnWebError);
    // runAgentKitWithAi is now IMPLEMENTED on web (gateway streaming, Phase 2b);
    // it validates its input rather than throwing NotAvailableOnWebError. See
    // test/web-client-sse.test.ts for its streaming behavior.
    await expect(client.runAgentKitWithAi({})).rejects.toThrow(/requires a kitId/);
  });

  it("updater + openFolder degrade quietly on web", async () => {
    const { client } = makeClient(() => ({ body: {} }));
    expect(await client.checkForUpdate()).toBeNull();
    await expect(client.openFolder()).resolves.toBeUndefined();
    await expect(client.markLibraryKitUsed()).resolves.toBeUndefined();
  });

  // --- new parity methods ----------------------------------------------------
  it("saveAiProvider POSTs /api/settings/ai-provider", async () => {
    const { client, calls } = makeClient(() => ({ body: { providers: [] } }));
    await client.saveAiProvider({
      name: "OpenAI",
      providerType: "openai",
      baseUrl: "",
      apiKey: "sk-1",
      defaultModel: "gpt-4o",
      supportsStructuredJson: true
    });
    expect(calls[0].url).toBe("/api/settings/ai-provider");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ providerType: "openai", apiKey: "sk-1" });
  });

  it("removeAiProvider DELETEs /api/settings/ai-provider with providerId", async () => {
    const { client, calls } = makeClient(() => ({ body: { providers: [] } }));
    await client.removeAiProvider("p1");
    expect(calls[0].url).toBe("/api/settings/ai-provider");
    expect(calls[0].init?.method).toBe("DELETE");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ providerId: "p1" });
  });

  it("setDefaultAiProvider POSTs /api/settings/ai-provider/default", async () => {
    const { client, calls } = makeClient(() => ({ body: { providers: [] } }));
    await client.setDefaultAiProvider("p2");
    expect(calls[0].url).toBe("/api/settings/ai-provider/default");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ providerId: "p2" });
  });

  it("testAiProviderConnection POSTs /api/settings/ai-provider/test", async () => {
    const { client, calls } = makeClient(() => ({ body: { ok: true, model: "gpt-4o", message: "ok" } }));
    const res = await client.testAiProviderConnection({ providerId: "p1", model: "" });
    expect(calls[0].url).toBe("/api/settings/ai-provider/test");
    expect(res.ok).toBe(true);
  });

  it("generateAgentKitDraftWithAi POSTs /api/drafts/generate", async () => {
    const { client, calls } = makeClient(() => ({ body: { draftJson: {}, session: {} } }));
    await client.generateAgentKitDraftWithAi({ userRequest: "make a kit" } as never);
    expect(calls[0].url).toBe("/api/drafts/generate");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ userRequest: "make a kit" });
  });

  it("reviseAgentKitDraftWithAi POSTs /api/drafts/revise", async () => {
    const { client, calls } = makeClient(() => ({ body: { draftJson: {}, session: {} } }));
    await client.reviseAgentKitDraftWithAi({ session: {}, changeRequest: "tweak" } as never);
    expect(calls[0].url).toBe("/api/drafts/revise");
  });

  it("renderGeneratedAgentKitDraft POSTs /api/kits/from-draft and returns kitId", async () => {
    const { client, calls } = makeClient(() => ({ body: { kit: { kitId: "rendered" } } }));
    const res = await client.renderGeneratedAgentKitDraft({ draftJson: { name: "x" }, outputFolder: "", force: true });
    expect(calls[0].url).toBe("/api/kits/from-draft");
    expect(res.kitId).toBe("rendered");
  });

  it("checkKitUpdate GETs /api/kits/update-check with query params", async () => {
    const { client, calls } = makeClient(() => ({ body: { available: true, updateAvailable: true, latestVersion: "2" } }));
    const res = await client.checkKitUpdate({ slug: "s", marketBaseUrl: "https://m", installedVersion: "1" });
    expect(calls[0].url).toContain("/api/kits/update-check?");
    expect(calls[0].url).toContain("slug=s");
    expect(res.updateAvailable).toBe(true);
  });

  it("submitHostedMarketKit POSTs /api/market/submit with kitId + listingDraft", async () => {
    const { client, calls } = makeClient(() => ({ body: { submissionId: "sub1", status: "validation_queued" } }));
    const res = (await client.submitHostedMarketKit({
      rootPath: "k1",
      marketBaseUrl: "",
      validationProfile: "publishable",
      listingDraft: { name: "Listing" }
    } as never)) as { submissionId?: string };
    expect(calls[0].url).toBe("/api/market/submit");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ kitId: "k1", listingDraft: { name: "Listing" } });
    expect(res.submissionId).toBe("sub1");
  });

  it("renderAgentKitDraft remains desktop-only stub", () => {
    const { client } = makeClient(() => ({ body: {} }));
    expect(() => client.renderAgentKitDraft()).toThrow(NotAvailableOnWebError);
  });

  it("summarizeExampleInputDocuments returns empty array for no paths (web uses direct upload route)", async () => {
    const { client } = makeClient(() => ({ body: {} }));
    const result = await client.summarizeExampleInputDocuments([]);
    expect(result).toEqual([]);
  });

  it("generate draft surfaces a 402 insufficient_credits body as HttpError (managed credits)", async () => {
    const { client } = makeClient(() => ({
      status: 402,
      body: { code: "insufficient_credits", message: "Out of credits.", requiredCents: 12, balanceCents: 3 }
    }));
    await expect(
      client.generateAgentKitDraftWithAi({ userRequest: "x" } as never)
    ).rejects.toMatchObject({
      name: "HttpError",
      status: 402,
      body: { code: "insufficient_credits", requiredCents: 12, balanceCents: 3 }
    });
    await expect(
      client.generateAgentKitDraftWithAi({ userRequest: "x" } as never)
    ).rejects.toBeInstanceOf(HttpError);
  });
});
