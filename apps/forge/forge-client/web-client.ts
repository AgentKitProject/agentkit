// WebForgeClient — the browser implementation of the `ForgeClient` interface.
//
// It satisfies the SAME interface the desktop `TauriForgeClient` does, but:
//   * PORTABLE methods call the Phase-1 HTTP endpoints under /api/* with
//     `credentials: "include"` so the AuthKit cookie session rides along.
//   * The web backend is keyed by `kitId` + file-tree (no native filesystem),
//     so every path-shaped argument (`path`, `rootPath`, `kitPath`) is treated
//     as a KIT ID. The UI passes `MyKitEntry.kitId` wherever the desktop UI
//     passed a folder path.
//   * package/export return BYTES/TEXT (the route streams them); the UI then
//     triggers a browser download. Save-path dialogs become downloads.
//   * DESKTOP-ONLY seams are mapped to web behavior (see each method) or, when
//     there is no sensible web equivalent, throw a clear "not available on web"
//     error so a caller fails loudly rather than silently.
//
// This module is browser-safe: it never imports `@agentkitforge/core`.

import type {
  AccountAuthConfigDiagnostics,
  AddKitToLibraryInput,
  AgentKitCandidateInspection,
  AgentKitPackagePreview,
  AgentKitStarterHint,
  AgentKitSummary,
  AiProviderInput,
  AiProviderTestResult,
  CheckKitUpdateInput,
  ClaudeCodeExportResult,
  CodexExportResult,
  CreateAgentKitInput,
  CreateAgentKitResult,
  DeviceLoginStart,
  ExampleInputDocument,
  ExportAgentKitResult,
  ExportOneFileInput,
  ExportToClaudeCodeInput,
  ExportToCodexInput,
  FetchLicensedMarketKitInput,
  FetchLicensedMarketKitResult,
  ForgeClient,
  GenerateAgentKitDraftInput,
  GenerateAgentKitDraftResult,
  ImportAgentKitFromGitInput,
  ImportAgentKitFromGitResult,
  ImportAgentKitPackageInput,
  ImportAgentKitPackageResult,
  ImportHostedMarketKitInput,
  KitMetadata,
  KitUpdateStatus,
  LoadAgentKitAsDraftResult,
  MyKitEntry,
  NextVersionResult,
  PackageAgentKitInput,
  PackageAgentKitResult,
  PreparedPrompt,
  PreparedPromptRenderResult,
  PublicSettings,
  RemoveKitFromLibraryResult,
  RenderAgentKitDraftInput,
  RenderAgentKitDraftResult,
  ReviseAgentKitDraftInput,
  RunAgentKitResult,
  SaveAgentKitDraftJsonArgs,
  SaveAppPreferencesInput,
  SaveMarkdownFileArgs,
  SubmitHostedMarketKitInput,
  SubmitHostedMarketKitResult,
  TestAiProviderInput,
  Update,
  ValidationProfile,
  ValidationReport
} from "./types";

/** Thrown by methods with no sensible web equivalent. */
export class NotAvailableOnWebError extends Error {
  constructor(method: string) {
    super(`${method} is not available on the web build of AgentKitForge.`);
    this.name = "NotAvailableOnWebError";
  }
}

/**
 * Thrown by json() for non-2xx responses. Carries the HTTP status and the
 * parsed JSON body so callers can branch on machine-readable error codes
 * (e.g. a 402 { code: "insufficient_credits", requiredCents, balanceCents }).
 */
export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export type WebForgeClientOptions = {
  /** Base path for the API (default ""). Useful for tests. */
  baseUrl?: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Trigger a browser download of bytes/text (no-op in non-DOM contexts). */
  download?: (data: Blob | string, fileName: string) => void;
  /** Open a URL (default window.open). */
  openUrl?: (url: string) => void;
};

function defaultDownload(data: Blob | string, fileName: string): void {
  if (typeof document === "undefined") return;
  const blob = typeof data === "string" ? new Blob([data], { type: "text/plain" }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export class WebForgeClient implements ForgeClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly download: (data: Blob | string, fileName: string) => void;
  private readonly openUrl: (url: string) => void;

  constructor(opts: WebForgeClientOptions = {}) {
    this.base = opts.baseUrl ?? "";
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.download = opts.download ?? defaultDownload;
    this.openUrl =
      opts.openUrl ?? ((url: string) => {
        if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
      });
  }

  // --- low-level transport ---------------------------------------------------
  private url(path: string): string {
    return `${this.base}${path}`;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(this.url(path), {
      credentials: "include",
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      ...init
    });
    const text = await res.text();
    const body = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const message =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : body && typeof body === "object" && "message" in body
            ? String((body as { message: unknown }).message)
            : `Request failed (${res.status})`;
      throw new HttpError(res.status, message, body);
    }
    return body as T;
  }

  private async bytes(path: string, init?: RequestInit): Promise<{ blob: Blob; fileName: string }> {
    const res = await this.fetchImpl(this.url(path), { credentials: "include", ...init });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = `Request failed (${res.status})`;
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (parsed?.error) message = String(parsed.error);
      } catch {
        /* not JSON */
      }
      throw new Error(message);
    }
    const blob = await res.blob();
    const fileName = parseFileName(res.headers.get("content-disposition"));
    return { blob, fileName };
  }

  // ===========================================================================
  // settings  (PORTABLE — single per-user settings doc)
  // ===========================================================================
  getAppSettings(): Promise<PublicSettings> {
    return this.json<PublicSettings>("/api/settings").catch(() => ({}) as PublicSettings);
  }
  saveAppPreferences(input: SaveAppPreferencesInput): Promise<PublicSettings> {
    return this.json<PublicSettings>("/api/settings", { method: "POST", body: JSON.stringify(input) });
  }
  saveOpenAiApiKey(apiKey: string): Promise<PublicSettings> {
    return this.json<PublicSettings>("/api/settings/openai-key", { method: "POST", body: JSON.stringify({ apiKey }) });
  }
  clearOpenAiApiKey(): Promise<PublicSettings> {
    return this.json<PublicSettings>("/api/settings/openai-key", { method: "DELETE" });
  }
  saveAiProvider(input: AiProviderInput): Promise<PublicSettings> {
    return this.json<PublicSettings>("/api/settings/ai-provider", { method: "POST", body: JSON.stringify(input) });
  }
  removeAiProvider(providerId: string): Promise<PublicSettings> {
    return this.json<PublicSettings>("/api/settings/ai-provider", {
      method: "DELETE",
      body: JSON.stringify({ providerId })
    });
  }
  setDefaultAiProvider(providerId: string): Promise<PublicSettings> {
    return this.json<PublicSettings>("/api/settings/ai-provider/default", {
      method: "POST",
      body: JSON.stringify({ providerId })
    });
  }
  testAiProviderConnection(input: TestAiProviderInput): Promise<AiProviderTestResult> {
    return this.json<AiProviderTestResult>("/api/settings/ai-provider/test", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }
  saveUpdateCheckTimestamp(): Promise<PublicSettings> {
    // WEB: no updater; nothing to record. Return current settings best-effort.
    return this.getAppSettings();
  }

  // ===========================================================================
  // auth / account
  // WEB: there is no device-auth flow. On the web the AuthKit cookie session
  // IS the AgentKitProject account — the user reaches the app already logged in
  // (middleware enforces it). These methods report that session state instead
  // of driving a device flow.
  // ===========================================================================
  async checkAgentKitProjectAuthConfig(): Promise<AccountAuthConfigDiagnostics> {
    const me = await this.json<{ user: { id: string; email?: string } | null }>("/api/account").catch(() => ({
      user: null
    }));
    return { configured: true, connected: Boolean(me.user), via: "authkit-session", user: me.user ?? undefined };
  }
  beginAgentKitProjectAccountLogin(): Promise<DeviceLoginStart> {
    // WEB: redirect to the AuthKit sign-in rather than starting a device flow.
    this.openUrl(this.url("/auth/sign-in"));
    throw new NotAvailableOnWebError(
      "beginAgentKitProjectAccountLogin (web uses the AuthKit cookie session; redirecting to /auth/sign-in)"
    );
  }
  completeAgentKitProjectAccountLogin(): Promise<PublicSettings> {
    // WEB: login completes via the AuthKit callback; settings are session-derived.
    return this.getAppSettings();
  }
  restoreAgentKitProjectAccount(): Promise<PublicSettings> {
    // WEB: the cookie session is restored by the browser automatically.
    return this.getAppSettings();
  }
  disconnectAgentKitProjectAccount(): Promise<PublicSettings> {
    // WEB: sign out = clear the AuthKit cookie session.
    this.openUrl(this.url("/auth/sign-out"));
    return Promise.resolve({} as PublicSettings);
  }

  // ===========================================================================
  // My Kits library  (PORTABLE — `path` arg === kitId on the web)
  // ===========================================================================
  async listMyKits(): Promise<MyKitEntry[]> {
    const { kits } = await this.json<{ kits: MyKitEntry[] }>("/api/kits");
    return kits;
  }
  addKitToLibrary(): Promise<MyKitEntry> {
    // WEB: there is no "add a local folder path to the library" concept — a kit
    // enters the store only via create/import. Callers should use those.
    throw new NotAvailableOnWebError("addKitToLibrary (use create/import on the web)");
  }
  removeKitFromLibrary(path: string): Promise<RemoveKitFromLibraryResult> {
    return this.json<RemoveKitFromLibraryResult>(`/api/kits/${encodeURIComponent(path)}`, { method: "DELETE" });
  }
  async refreshKitMetadata(path: string): Promise<MyKitEntry> {
    const { kit } = await this.json<{ kit: MyKitEntry }>(`/api/kits/${encodeURIComponent(path)}`);
    return kit;
  }
  markLibraryKitUsed(): Promise<void> {
    // WEB: "last used" tracking is desktop-only bookkeeping; treat as a no-op.
    return Promise.resolve();
  }
  validateLibraryKit(path: string): Promise<ValidationReport> {
    return this.validateAgentKit({ path, profile: "local-valid" });
  }
  async getAgentKitSummary(path: string): Promise<AgentKitSummary> {
    const { summary } = await this.json<{ summary: AgentKitSummary }>(`/api/kits/${encodeURIComponent(path)}/summary`);
    return summary;
  }
  checkKitUpdate(input: CheckKitUpdateInput): Promise<KitUpdateStatus> {
    const qs = new URLSearchParams();
    if (input.marketBaseUrl) qs.set("marketBaseUrl", input.marketBaseUrl);
    if (input.slug) qs.set("slug", input.slug);
    if (input.installedVersion) qs.set("installedVersion", input.installedVersion);
    return this.json<KitUpdateStatus>(`/api/kits/update-check?${qs.toString()}`).catch(
      () => ({}) as KitUpdateStatus
    );
  }

  // ===========================================================================
  // inspect / metadata  (`rootPath`/`path` === kitId)
  // ===========================================================================
  async getAgentKitMetadata(rootPath: string): Promise<KitMetadata> {
    const { kit } = await this.json<{ kit: KitMetadata }>(`/api/kits/${encodeURIComponent(rootPath)}`);
    return kit;
  }
  getAgentKitStarterHint(): Promise<AgentKitStarterHint | null> {
    // Best-effort; not surfaced by the Phase-1 backend.
    return Promise.resolve(null);
  }
  inspectAgentKitCandidate(): Promise<AgentKitCandidateInspection> {
    throw new NotAvailableOnWebError("inspectAgentKitCandidate (no local folder paths on the web)");
  }
  inspectAgentKitPackage(): Promise<AgentKitPackagePreview> {
    // WEB: package inspection happens server-side during import-zip; there is no
    // pre-pick local path to inspect.
    throw new NotAvailableOnWebError("inspectAgentKitPackage (upload via importAgentKitPackage instead)");
  }
  nextAgentKitVersion(rootPath: string): Promise<NextVersionResult> {
    return this.json<NextVersionResult>(`/api/kits/${encodeURIComponent(rootPath)}/next-version`);
  }

  // ===========================================================================
  // import
  // ===========================================================================
  async importAgentKitPackage(input: ImportAgentKitPackageInput): Promise<ImportAgentKitPackageResult> {
    // WEB: `packagePath` carries an uploaded File (set by the UI's file input)
    // under the `file` key. Send it as multipart to /api/import/zip.
    const file = (input as { file?: File }).file;
    if (!(typeof File !== "undefined" && file instanceof File)) {
      throw new Error("importAgentKitPackage on the web requires an uploaded File (input.file).");
    }
    const form = new FormData();
    form.append("file", file);
    return this.json<ImportAgentKitPackageResult>("/api/import/zip", { method: "POST", body: form, headers: {} });
  }
  importAgentKitFromGit(input: ImportAgentKitFromGitInput): Promise<ImportAgentKitFromGitResult> {
    return this.json<ImportAgentKitFromGitResult>("/api/import/git", {
      method: "POST",
      body: JSON.stringify({ repositoryUrl: input.repositoryUrl, reference: input.reference })
    });
  }
  importHostedMarketKit(input: ImportHostedMarketKitInput): Promise<ImportAgentKitPackageResult> {
    return this.json<ImportAgentKitPackageResult>("/api/import/market", {
      method: "POST",
      body: JSON.stringify({ slug: input.slug, kitId: input.kitId, marketBaseUrl: input.marketBaseUrl })
    });
  }
  fetchLicensedMarketKit(input: FetchLicensedMarketKitInput): Promise<FetchLicensedMarketKitResult> {
    return this.json<FetchLicensedMarketKitResult>("/api/market/licensed", {
      method: "POST",
      body: JSON.stringify({ slug: input.slug, kitId: input.kitId, marketBaseUrl: input.marketBaseUrl })
    });
  }

  // ===========================================================================
  // build / draft / AI generate
  // ===========================================================================
  async createAgentKitFromTemplate(input: CreateAgentKitInput): Promise<CreateAgentKitResult> {
    const { kit } = await this.json<{ kit: MyKitEntry }>("/api/kits/from-template", {
      method: "POST",
      body: JSON.stringify({
        template: input.template,
        id: input.id,
        name: input.name,
        description: input.description
      })
    });
    return { ...kit, kitId: kit.kitId };
  }
  async loadAgentKitAsDraft(path: string): Promise<LoadAgentKitAsDraftResult> {
    const { draft } = await this.json<{ draft: unknown }>(`/api/kits/${encodeURIComponent(path)}/draft`);
    return { draft };
  }
  renderAgentKitDraft(): Promise<RenderAgentKitDraftResult> {
    // WEB: the desktop "render into a chosen folder" has no path analog; use
    // renderGeneratedAgentKitDraft, which creates a kit in the store.
    throw new NotAvailableOnWebError("renderAgentKitDraft (use renderGeneratedAgentKitDraft on the web)");
  }
  async renderGeneratedAgentKitDraft(input: {
    draftJson: unknown;
    outputFolder: string;
    force: boolean;
  }): Promise<RenderAgentKitDraftResult> {
    const { kit } = await this.json<{ kit: MyKitEntry }>("/api/kits/from-draft", {
      method: "POST",
      body: JSON.stringify({ draftJson: input.draftJson })
    });
    return { ...kit, kitId: kit.kitId };
  }
  generateAgentKitDraftWithAi(input: GenerateAgentKitDraftInput): Promise<GenerateAgentKitDraftResult> {
    return this.json<GenerateAgentKitDraftResult>("/api/drafts/generate", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }
  reviseAgentKitDraftWithAi(input: ReviseAgentKitDraftInput): Promise<GenerateAgentKitDraftResult> {
    return this.json<GenerateAgentKitDraftResult>("/api/drafts/revise", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }
  summarizeExampleInputDocuments(_paths: string[]): Promise<ExampleInputDocument[]> {
    // WEB: the desktop `paths` arg is a filesystem path array (not available on
    // the web). Web uploads are handled directly in ExampleDocsPanel via the
    // /api/drafts/summarize-examples route with FormData. This method is kept
    // to satisfy the ForgeClient interface; the web UI calls the route directly.
    return Promise.resolve([]);
  }

  /** Web-only: upload File objects to /api/drafts/summarize-examples. */
  async summarizeExampleInputDocumentsWeb(files: File[]): Promise<ExampleInputDocument[]> {
    if (files.length === 0) return [];
    const form = new FormData();
    for (const f of files) form.append("file", f);
    const res = await this.fetchImpl(this.url("/api/drafts/summarize-examples"), {
      method: "POST",
      credentials: "include",
      body: form
    });
    const body = (await res.json()) as { summaries?: ExampleInputDocument[]; error?: string };
    if (!res.ok) throw new Error(body.error ?? `summarizeExampleInputDocuments failed (${res.status})`);
    return body.summaries ?? [];
  }

  // ===========================================================================
  // validate  (`rootPath`/`path` === kitId)
  // ===========================================================================
  async validateAgentKit(args: {
    rootPath?: string;
    path?: string;
    profile: ValidationProfile;
  }): Promise<ValidationReport> {
    const kitId = args.rootPath ?? args.path;
    if (!kitId) throw new Error("validateAgentKit requires a kit id (rootPath/path).");
    const { report } = await this.json<{ report: ValidationReport }>(
      `/api/kits/${encodeURIComponent(kitId)}/validate`,
      { method: "POST", body: JSON.stringify({ profile: args.profile }) }
    );
    return report;
  }

  // ===========================================================================
  // package / export
  // WEB: `rootPath`/`kitPath` === kitId; the route streams bytes/text, which we
  // hand to the browser as a download. The returned `filePath`/`fileName`
  // reflects the download name (there is no server path).
  // ===========================================================================
  async packageAgentKit(input: PackageAgentKitInput): Promise<PackageAgentKitResult> {
    const { blob, fileName } = await this.bytes(`/api/kits/${encodeURIComponent(input.rootPath)}/package`, {
      method: "POST"
    });
    this.download(blob, fileName);
    return { fileName, filePath: fileName };
  }
  async exportAgentKitOneFile(input: ExportOneFileInput): Promise<ExportAgentKitResult> {
    const { text, fileName } = await this.json<{ text: string; fileName: string }>(
      `/api/kits/${encodeURIComponent(input.rootPath)}/export/onefile`,
      { method: "POST" }
    );
    this.download(text, fileName);
    return { text, fileName, filePath: fileName };
  }
  async exportAgentKitToCodex(input: ExportToCodexInput): Promise<CodexExportResult> {
    const { blob, fileName } = await this.bytes(`/api/kits/${encodeURIComponent(input.kitPath)}/export/codex`, {
      method: "POST"
    });
    this.download(blob, fileName);
    return { fileName };
  }
  async exportAgentKitToClaudeCode(input: ExportToClaudeCodeInput): Promise<ClaudeCodeExportResult> {
    const { blob, fileName } = await this.bytes(
      `/api/kits/${encodeURIComponent(input.kitPath)}/export/claude-code`,
      { method: "POST" }
    );
    this.download(blob, fileName);
    return { fileName };
  }

  // ===========================================================================
  // prepared prompts / use  (`rootPath` === kitId)
  // ===========================================================================
  async listPreparedPrompts(rootPath: string): Promise<PreparedPrompt[]> {
    const { prompts } = await this.json<{ prompts: PreparedPrompt[] }>(
      `/api/kits/${encodeURIComponent(rootPath)}/prepared-prompts`
    );
    return prompts;
  }
  renderPreparedPrompt(input: {
    rootPath: string;
    promptId: string;
    inputValues: Record<string, unknown>;
  }): Promise<PreparedPromptRenderResult> {
    return this.json<PreparedPromptRenderResult>(
      `/api/kits/${encodeURIComponent(input.rootPath)}/prepared-prompts/render`,
      { method: "POST", body: JSON.stringify({ promptId: input.promptId, inputValues: input.inputValues }) }
    );
  }
  /**
   * Run / chat with a kit using MANAGED AI (Gateway Phase 2b).
   *
   * Flow:
   *   1. POST /api/gateway/sessions for the kit (managed billing, selected model)
   *      → opaque session handle. Reused across turns until end.
   *   2. POST /api/gateway/sessions/{id}/turn with { userInput, model } → an SSE
   *      stream of normalized events. We parse `data:` frames and invoke
   *      `onEvent` for text deltas, usage, and done; `onToken` for raw text.
   *
   * CONVERSATIONAL-ONLY this pass: we do NOT pass tools and do NOT execute tools
   * in the browser. If the stream ever emits a `tool_use` event we ignore it
   * gracefully (the model won't request tools since none are declared). Desktop
   * local-hands (2c) + a future restricted browser tool executor will drive the
   * /tool-result round-trips — the seam (resumeWithToolResults + the route) is in
   * place server-side.
   *
   * The caller passes:
   *   { kitId, prompt, model?, sessionId?, onEvent?, onToken?, signal? }
   * and gets back { sessionId, text, usage?, stopReason }. Pass the returned
   * `sessionId` on the next call to continue the same conversation; omit it (or
   * call endAgentKitSession) to start/clean up.
   */
  async runAgentKitWithAi(input: Record<string, unknown>): Promise<RunAgentKitResult> {
    const kitId = typeof input.kitId === "string" ? input.kitId : (input.rootPath as string | undefined);
    const prompt = typeof input.prompt === "string" ? input.prompt : (input.userInput as string | undefined);
    // A PROTECTED Market kit run: the session is created with the protected
    // selector { source:"market", slug, kitId }. The server classifies + gates
    // entitlement, fetches the kit content server-side, and NEVER returns the
    // prompt. The browser only ever supplies the public slug/id — no content.
    const marketSlug = typeof input.marketSlug === "string" ? input.marketSlug : undefined;
    const marketKitId = typeof input.marketKitId === "string" ? input.marketKitId : undefined;
    // A local kit needs a kitId; a protected Market kit is keyed by its slug.
    if (!kitId && !marketSlug) throw new Error("runAgentKitWithAi requires a kitId.");
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new Error("runAgentKitWithAi requires a non-empty prompt.");
    }
    const model = typeof input.model === "string" ? input.model : undefined;
    const onEvent = input.onEvent as ((ev: GatewayStreamEvent) => void) | undefined;
    const onToken = input.onToken as ((delta: string) => void) | undefined;
    const signal = input.signal as AbortSignal | undefined;

    // 1. Reuse an existing session or create one for this kit.
    let sessionId = typeof input.sessionId === "string" ? input.sessionId : undefined;
    if (!sessionId) {
      const createBody = marketSlug
        ? {
            source: "market",
            slug: marketSlug,
            ...(marketKitId ? { kitId: marketKitId } : {}),
            ...(model ? { model } : {})
          }
        : { kitId, billing: "managed", ...(model ? { model } : {}) };
      const created = await this.json<{ sessionId: string }>("/api/gateway/sessions", {
        method: "POST",
        body: JSON.stringify(createBody)
      });
      sessionId = created.sessionId;
    }

    // 2. Run a turn and consume the SSE stream.
    const res = await this.fetchImpl(this.url(`/api/gateway/sessions/${encodeURIComponent(sessionId)}/turn`), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userInput: prompt, ...(model ? { model } : {}) }),
      ...(signal ? { signal } : {})
    });

    if (!res.ok) {
      // Pre-stream error (e.g. 402 insufficient-credits) arrives as JSON, not SSE.
      const text = await res.text().catch(() => "");
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      const message =
        body && typeof body === "object" && "message" in body
          ? String((body as { message: unknown }).message)
          : `Turn failed (${res.status})`;
      throw new HttpError(res.status, message, body);
    }

    let text = "";
    let usage: GatewayUsage | undefined;
    let stopReason = "end_turn";
    let streamError: string | undefined;

    await consumeSse(res, (ev) => {
      switch (ev.type) {
        case "text":
          text += ev.delta;
          onToken?.(ev.delta);
          onEvent?.(ev);
          break;
        case "usage":
          usage = { input: ev.input, output: ev.output, cached: ev.cached };
          onEvent?.(ev);
          break;
        case "done":
          stopReason = ev.stopReason;
          onEvent?.(ev);
          break;
        case "error":
          streamError = ev.message;
          onEvent?.(ev);
          break;
        case "tool_use":
          // Ignored: no tools declared this pass. See method doc — desktop
          // local-hands (2c) / a future browser tool executor handle these.
          onEvent?.(ev);
          break;
      }
    });

    if (streamError) throw new Error(streamError);
    return { sessionId, text, usage, stopReason };
  }

  /** End a gateway session (cleanup on unmount/end). Fire-and-forget; ignores errors. */
  async endAgentKitSession(sessionId: string): Promise<void> {
    if (!sessionId) return;
    await this.fetchImpl(this.url(`/api/gateway/sessions/${encodeURIComponent(sessionId)}`), {
      method: "DELETE",
      credentials: "include"
    }).catch(() => {
      /* best-effort cleanup */
    });
  }

  // ===========================================================================
  // market submit
  // ===========================================================================
  submitHostedMarketKit(input: SubmitHostedMarketKitInput): Promise<SubmitHostedMarketKitResult> {
    const listingDraft = (input as { listingDraft?: unknown }).listingDraft;
    return this.json<SubmitHostedMarketKitResult>("/api/market/submit", {
      method: "POST",
      body: JSON.stringify({
        kitId: input.rootPath,
        marketBaseUrl: input.marketBaseUrl || undefined,
        listingDraft
      })
    });
  }

  // ===========================================================================
  // dialogs  (WEB: native pickers -> browser <input type=file> / downloads)
  // These return synthetic tokens. The web UI prefers calling the typed methods
  // above directly with an uploaded File rather than the desktop pick->path
  // dance, so these are thin fallbacks.
  // ===========================================================================
  selectAgentKitFolder(): Promise<string | null> {
    // No folder picker on the web (and no server-side local folders).
    return Promise.resolve(null);
  }
  selectAgentKitPackageFile(): Promise<string | null> {
    return this.pickFile(".zip,.agentkit.zip");
  }
  selectJsonFile(): Promise<string | null> {
    return this.pickFile(".json");
  }
  selectJsonOutputPath(): Promise<string | null> {
    // Save target -> a download file name (no real path on the web).
    return Promise.resolve("agentkit-draft.json");
  }
  selectOnefileOutputPath(): Promise<string | null> {
    return Promise.resolve("agentkit.onefile.md");
  }
  selectExampleInputDocuments(): Promise<string[]> {
    return Promise.resolve([]);
  }
  selectForgeResponseOutputPath(fileName: string): Promise<string | null> {
    return Promise.resolve(fileName);
  }
  selectForgeResponseTextOutputPath(fileName: string): Promise<string | null> {
    return Promise.resolve(fileName);
  }
  saveAgentKitDraftJson(args: SaveAgentKitDraftJsonArgs): Promise<{ filePath: string }> {
    const fileName = args.outputPath || "agentkit-draft.json";
    this.download(JSON.stringify(args.input.draftJson, null, 2), fileName);
    return Promise.resolve({ filePath: fileName });
  }
  saveMarkdownFile(args: SaveMarkdownFileArgs): Promise<{ filePath: string }> {
    const fileName = args.outputPath || "agentkit.md";
    this.download(args.input.content, fileName);
    return Promise.resolve({ filePath: fileName });
  }

  /** Open a hidden <input type=file>; resolve to a synthetic token URL. */
  private pickFile(accept: string): Promise<string | null> {
    if (typeof document === "undefined") return Promise.resolve(null);
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.onchange = () => {
        const file = input.files?.[0] ?? null;
        resolve(file ? `web-file:${file.name}` : null);
      };
      input.click();
    });
  }

  // ===========================================================================
  // shell / misc
  // ===========================================================================
  openFolder(): Promise<void> {
    // WEB: no OS file manager; this is a no-op (the desktop "reveal in Finder").
    return Promise.resolve();
  }
  openExternalUrl(url: string): Promise<void> {
    this.openUrl(url);
    return Promise.resolve();
  }
  async getAppVersion(): Promise<string> {
    const health = await this.json<{ version?: string }>("/health").catch(() => ({}) as { version?: string });
    return health.version ?? "web";
  }

  // ===========================================================================
  // deep links  (WEB: OS deep links -> URL query params / in-app routing)
  // ===========================================================================
  getInitialDeepLinks(): Promise<string[]> {
    if (typeof window === "undefined") return Promise.resolve([]);
    const params = window.location.search;
    return Promise.resolve(params ? [`${window.location.origin}${window.location.pathname}${params}`] : []);
  }
  onDeepLink(callback: (urls: string[]) => void): Promise<() => void> {
    if (typeof window === "undefined") return Promise.resolve(() => {});
    const handler = () => callback([window.location.href]);
    window.addEventListener("popstate", handler);
    return Promise.resolve(() => window.removeEventListener("popstate", handler));
  }

  // ===========================================================================
  // updater  (WEB: a hosted web app self-updates on reload — no Tauri updater)
  // ===========================================================================
  checkForUpdate(): Promise<Update | null> {
    return Promise.resolve(null);
  }
  relaunchApp(): Promise<void> {
    if (typeof window !== "undefined") window.location.reload();
    return Promise.resolve();
  }
}

function parseFileName(contentDisposition: string | null): string {
  if (!contentDisposition) return "download";
  const match = /filename="?([^"]+)"?/.exec(contentDisposition);
  return match?.[1] ?? "download";
}

// ---------------------------------------------------------------------------
// Gateway streaming (runAgentKitWithAi)
// ---------------------------------------------------------------------------

/** Token usage reported by the gateway over the stream. */
export type GatewayUsage = { input: number; output: number; cached: number };

/**
 * The normalized StreamEvent union the gateway emits over SSE. Mirrors
 * @agentkitforge/gateway-core's `StreamEvent` but declared locally so this
 * browser module never imports the server package.
 */
export type GatewayStreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_use"; toolUseId: string; name: string; inputPartial?: string; inputComplete?: Record<string, unknown> }
  | { type: "usage"; input: number; output: number; cached: number }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string };

/**
 * Reads a `text/event-stream` Response body and invokes `onEvent` for each
 * parsed StreamEvent. Handles chunk boundaries that split SSE frames or JSON
 * across reads by buffering until a full `\n\n`-delimited frame is available.
 * Resolves when the stream ends.
 */
export async function consumeSse(
  res: Response,
  onEvent: (event: GatewayStreamEvent) => void
): Promise<void> {
  const body = res.body;
  if (!body) {
    // No streaming body (e.g. a test stub returned text) — parse the whole text.
    const text = await res.text();
    for (const frame of text.split("\n\n")) emitFrame(frame, onEvent);
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Process all complete frames (separated by a blank line).
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      emitFrame(frame, onEvent);
    }
  }
  // Flush any trailing frame without a terminating blank line.
  if (buffer.trim()) emitFrame(buffer, onEvent);
}

/** Parses one SSE frame (its `data:` lines) into a StreamEvent and emits it. */
function emitFrame(frame: string, onEvent: (event: GatewayStreamEvent) => void): void {
  const dataLines = frame
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""));
  if (dataLines.length === 0) return;
  const json = dataLines.join("\n");
  if (!json || json === "[DONE]") return;
  try {
    const parsed = JSON.parse(json) as GatewayStreamEvent;
    if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
      onEvent(parsed);
    }
  } catch {
    /* ignore malformed frame */
  }
}
