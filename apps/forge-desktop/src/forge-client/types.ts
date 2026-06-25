// Phase 0 of the AgentKitForge WebApp port.
//
// `ForgeClient` is the single typed transport abstraction the React UI talks to
// instead of calling Tauri `invoke()` (or Tauri plugin APIs) directly. On the
// desktop app this is implemented by `TauriForgeClient` (a faithful 1:1 wrapper
// around the current invoke()/plugin calls). A future web build will provide a
// `FetchForgeClient` that talks to a server over HTTP.
//
// Behavior on desktop must remain byte-for-byte equivalent: every method
// forwards exactly the same command name and args object that the UI used to
// build inline, and returns exactly the same shape the Rust command returns.
//
// Types consumed/returned by the backend are defined (and `export`ed) in
// `../App` — the single source of truth today — and imported here as
// type-only imports. Type-only imports are erased at compile time, so the
// App <-> forge-client cycle never exists at runtime.

import type { Update } from "@tauri-apps/plugin-updater";

import type {
  AccountAuthConfigDiagnostics,
  AgentKitCandidateInspection,
  AgentKitPackagePreview,
  AgentKitStarterHint,
  AgentKitSummary,
  AgentKitTemplate,
  ClaudeCodeExportResult,
  CodexExportResult,
  CreateAgentKitInput,
  CreateAgentKitResult,
  DeviceLoginStart,
  ExampleInputDocument,
  ExportAgentKitResult,
  FetchLicensedMarketKitResult,
  GenerateAgentKitDraftInput,
  GenerateAgentKitDraftResult,
  ImportAgentKitFromGitResult,
  ImportAgentKitPackageResult,
  KitLibrarySource,
  KitMetadata,
  KitUpdateStatus,
  LoadAgentKitAsDraftResult,
  MyKitEntry,
  PackageAgentKitResult,
  PreparedPrompt,
  PreparedPromptRenderResult,
  PublicSettings,
  RemoveKitFromLibraryResult,
  RenderAgentKitDraftInput,
  RenderAgentKitDraftResult,
  ReviseAgentKitDraftInput,
  RunAgentKitResult,
  SubmitHostedMarketKitResult,
  ValidationProfile,
  ValidationReport,
} from "../App";

// --- argument payloads -------------------------------------------------------
// These mirror the inner `input`/arg objects the UI currently builds inline.
// The Tauri client re-wraps them in `{ input }` where the Rust command expects
// it; web clients will serialize them to JSON request bodies.

// --- gateway run / chat (Phase 2c-iii) ---------------------------------------

export type GatewayRunInput = {
  /** Stable id the caller generates to scope this run's streamed events. */
  runId: string;
  /** The kit's workspace root; local-hands file tools are confined here. */
  workspacePath: string;
  /** Pre-rendered kit context (system text), built on the desktop. */
  kitContext?: string;
  systemPrompt?: string;
  /** Managed model id (e.g. "claude-sonnet-4-6"). */
  model: string;
  /** The user's prompt that starts the turn. */
  input: string;
  /** Enable the workspace-scoped local-hands tool set (experimental). */
  enableLocalHands?: boolean;
  /** Enable the `run_command` tool (off by default; each call still prompts). */
  enableRunCommand?: boolean;
  /** Optional gateway base URL override. */
  gatewayBaseUrl?: string;
};

/** A normalized event streamed from a Gateway run, forwarded from the bridge. */
export type GatewayRunEvent =
  | { type: "text"; delta: string }
  | { type: "tool_use"; toolUseId: string; name: string; input: unknown }
  | {
      type: "tool_result";
      toolUseId: string;
      name?: string;
      result?: unknown;
      error?: string;
    }
  | { type: "usage"; usage?: Record<string, unknown> }
  | { type: "done"; stopReason: string; toolRounds?: number }
  | { type: "error"; message?: string; code?: string }
  | { type: string; [key: string]: unknown };

export type GatewayRunResult = {
  stopReason: string;
  toolRounds: number;
};

export type AddKitToLibraryInput = {
  path: string;
  source: KitLibrarySource | string;
  // Import flows attach optional provenance/package metadata; keep open.
  [key: string]: unknown;
};

export type ImportAgentKitPackageInput = {
  packagePath: string;
  destinationRootFolder: string;
  validationProfile: ValidationProfile;
  force: boolean;
  // The UI builds this object via a form; keep it open for any extra fields.
  [key: string]: unknown;
};

export type ImportHostedMarketKitInput = {
  slug: string;
  kitId?: string;
  marketBaseUrl: string;
  validationProfile: ValidationProfile;
  [key: string]: unknown;
};

export type FetchLicensedMarketKitInput = {
  slug: string;
  kitId?: string;
  marketBaseUrl: string;
  validationProfile: ValidationProfile;
  [key: string]: unknown;
};

export type ImportAgentKitFromGitInput = {
  repositoryUrl: string;
  reference: string;
  destinationRootFolder: string;
  validationProfile: ValidationProfile;
};

export type ExportOneFileInput = {
  rootPath: string;
  outputPath: string;
};

export type ExportToClaudeCodeInput = {
  kitPath: string;
  destinationDir: string;
  force: boolean;
};

export type ExportToCodexInput = {
  kitPath: string;
  destinationSkillsDir: string;
  force: boolean;
};

export type PackageAgentKitInput = {
  rootPath: string;
  outputFolder: string;
};

export type SubmitHostedMarketKitInput = {
  rootPath: string;
  marketBaseUrl: string;
  validationProfile: ValidationProfile;
};

export type SaveAgentKitDraftJsonArgs = {
  input: { draftJson: unknown };
  outputPath: string;
};

export type SaveMarkdownFileArgs = {
  input: { content: string };
  outputPath: string;
};

export type SaveAppPreferencesInput = {
  defaultModel: string;
  defaultOutputFolder: string;
  preferredValidationProfile: ValidationProfile;
  preferredContextMode: "all" | "triggered";
  theme: "light" | "dark";
  includePolicies: boolean;
  includeTemplates: boolean;
  includeWorkflows: boolean;
  includeReferences: boolean;
  [key: string]: unknown;
};

export type AiProviderInput = {
  id?: string;
  name: string;
  providerType: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  supportsStructuredJson: boolean;
  [key: string]: unknown;
};

export type TestAiProviderInput = {
  providerId: string | undefined;
  model: string;
};

export type CheckKitUpdateInput = {
  marketBaseUrl?: string;
  slug?: string;
  installedVersion?: string;
};

/** A synced cloud favorite (opt-in; only used when the account is connected). */
export type CloudFavorite = {
  kitId: string;
  slug: string;
  addedAt: string;
  displayName?: string | null;
  summary?: string | null;
  publisherName?: string | null;
};

export type CloudFavoritesResult = { items: CloudFavorite[] };

export type AddCloudFavoriteInput = {
  slug?: string;
  kitId?: string;
  marketBaseUrl?: string;
};

export type AiProviderTestResult = { ok: boolean; model: string; message: string };
export type NextVersionResult = { previous: string; next: string };

/**
 * The single typed transport surface between the UI and the backend.
 *
 * Methods are grouped by feature area. Each maps 1:1 to a Rust `#[tauri::command]`
 * on desktop, or to a server endpoint / browser API in a future web build.
 */
export interface ForgeClient {
  // --- settings ------------------------------------------------------------
  getAppSettings(): Promise<PublicSettings>;
  saveAppPreferences(input: SaveAppPreferencesInput): Promise<PublicSettings>;
  saveOpenAiApiKey(apiKey: string): Promise<PublicSettings>;
  clearOpenAiApiKey(): Promise<PublicSettings>;
  saveAiProvider(input: AiProviderInput): Promise<PublicSettings>;
  removeAiProvider(providerId: string): Promise<PublicSettings>;
  setDefaultAiProvider(providerId: string): Promise<PublicSettings>;
  testAiProviderConnection(input: TestAiProviderInput): Promise<AiProviderTestResult>;
  saveUpdateCheckTimestamp(checkedAt: string): Promise<PublicSettings>;

  // --- auth / account ------------------------------------------------------
  checkAgentKitProjectAuthConfig(): Promise<AccountAuthConfigDiagnostics>;
  beginAgentKitProjectAccountLogin(): Promise<DeviceLoginStart>;
  completeAgentKitProjectAccountLogin(loginId: string): Promise<PublicSettings>;
  restoreAgentKitProjectAccount(): Promise<PublicSettings>;
  disconnectAgentKitProjectAccount(): Promise<PublicSettings>;

  // --- My Kits library -----------------------------------------------------
  listMyKits(): Promise<MyKitEntry[]>;
  addKitToLibrary(input: AddKitToLibraryInput): Promise<MyKitEntry>;
  removeKitFromLibrary(path: string): Promise<RemoveKitFromLibraryResult>;
  refreshKitMetadata(path: string): Promise<MyKitEntry>;
  markLibraryKitUsed(path: string): Promise<void>;
  validateLibraryKit(path: string): Promise<ValidationReport>;
  getAgentKitSummary(path: string): Promise<AgentKitSummary>;
  checkKitUpdate(input: CheckKitUpdateInput): Promise<KitUpdateStatus>;

  // --- cloud favorites (opt-in; account-connected only) --------------------
  listCloudFavorites(marketBaseUrl?: string): Promise<CloudFavoritesResult>;
  addCloudFavorite(input: AddCloudFavoriteInput): Promise<CloudFavoritesResult>;
  removeCloudFavorite(kitId: string, marketBaseUrl?: string): Promise<void>;

  // --- inspect / metadata --------------------------------------------------
  getAgentKitMetadata(rootPath: string): Promise<KitMetadata>;
  getAgentKitStarterHint(rootPath: string): Promise<AgentKitStarterHint | null>;
  inspectAgentKitCandidate(path: string): Promise<AgentKitCandidateInspection>;
  inspectAgentKitPackage(packagePath: string): Promise<AgentKitPackagePreview>;
  nextAgentKitVersion(rootPath: string): Promise<NextVersionResult>;

  // --- import --------------------------------------------------------------
  importAgentKitPackage(input: ImportAgentKitPackageInput): Promise<ImportAgentKitPackageResult>;
  importAgentKitFromGit(input: ImportAgentKitFromGitInput): Promise<ImportAgentKitFromGitResult>;
  importHostedMarketKit(input: ImportHostedMarketKitInput): Promise<ImportAgentKitPackageResult>;
  fetchLicensedMarketKit(input: FetchLicensedMarketKitInput): Promise<FetchLicensedMarketKitResult>;

  // --- build / draft / AI generate ----------------------------------------
  createAgentKitFromTemplate(input: CreateAgentKitInput): Promise<CreateAgentKitResult>;
  loadAgentKitAsDraft(path: string): Promise<LoadAgentKitAsDraftResult>;
  renderAgentKitDraft(input: RenderAgentKitDraftInput): Promise<RenderAgentKitDraftResult>;
  renderGeneratedAgentKitDraft(input: {
    draftJson: unknown;
    outputFolder: string;
    force: boolean;
  }): Promise<RenderAgentKitDraftResult>;
  generateAgentKitDraftWithAi(input: GenerateAgentKitDraftInput): Promise<GenerateAgentKitDraftResult>;
  reviseAgentKitDraftWithAi(input: ReviseAgentKitDraftInput): Promise<GenerateAgentKitDraftResult>;
  summarizeExampleInputDocuments(paths: string[]): Promise<ExampleInputDocument[]>;

  // --- validate ------------------------------------------------------------
  // Args are forwarded verbatim to preserve the exact key each call site used
  // historically (`rootPath` for most sites, `path` for the folder-import flow).
  validateAgentKit(args: {
    rootPath?: string;
    path?: string;
    profile: ValidationProfile;
  }): Promise<ValidationReport>;

  // --- package / export ----------------------------------------------------
  packageAgentKit(input: PackageAgentKitInput): Promise<PackageAgentKitResult>;
  exportAgentKitOneFile(input: ExportOneFileInput): Promise<ExportAgentKitResult>;
  exportAgentKitToCodex(input: ExportToCodexInput): Promise<CodexExportResult>;
  exportAgentKitToClaudeCode(input: ExportToClaudeCodeInput): Promise<ClaudeCodeExportResult>;

  // --- prepared prompts / use ---------------------------------------------
  listPreparedPrompts(rootPath: string): Promise<PreparedPrompt[]>;
  renderPreparedPrompt(input: {
    rootPath: string;
    promptId: string;
    inputValues: Record<string, unknown>;
  }): Promise<PreparedPromptRenderResult>;
  runAgentKitWithAi(input: Record<string, unknown>): Promise<RunAgentKitResult>;

  // --- gateway run / chat (Phase 2c-iii) -----------------------------------
  // Run an Agent Kit through the hosted Gateway (managed billing) with optional
  // desktop "local hands". Online-only: requires a connected AgentKitProject
  // account. Events (text deltas, tool calls/results, done/error) stream via
  // `onEvent`; the returned promise resolves with the terminal result. WEB: a
  // hosted web build runs the same loop in-browser; this method is the seam.
  runAgentKitWithGateway(
    input: GatewayRunInput,
    onEvent: (event: GatewayRunEvent) => void,
  ): Promise<GatewayRunResult>;

  // --- market submit -------------------------------------------------------
  submitHostedMarketKit(input: SubmitHostedMarketKitInput): Promise<SubmitHostedMarketKitResult>;

  // --- dialogs (file pickers / save paths) --------------------------------
  // WEB: native OS dialogs have no browser equivalent. A web build will use
  // <input type="file"> / drag-drop for opens, and download blobs / the File
  // System Access API (showSaveFilePicker) for save targets — these methods
  // are the seam where that swap happens.
  selectAgentKitFolder(): Promise<string | null>;
  selectAgentKitPackageFile(): Promise<string | null>;
  selectJsonFile(): Promise<string | null>;
  selectJsonOutputPath(): Promise<string | null>;
  selectOnefileOutputPath(): Promise<string | null>;
  selectExampleInputDocuments(): Promise<string[]>;
  selectForgeResponseOutputPath(fileName: string): Promise<string | null>;
  selectForgeResponseTextOutputPath(fileName: string): Promise<string | null>;
  saveAgentKitDraftJson(args: SaveAgentKitDraftJsonArgs): Promise<{ filePath: string }>;
  saveMarkdownFile(args: SaveMarkdownFileArgs): Promise<{ filePath: string }>;

  // --- shell / misc --------------------------------------------------------
  // WEB: `openFolder` reveals a path in the OS file manager — no web analog;
  // a web build would surface a download or a no-op. `openExternalUrl` maps to
  // window.open on the web.
  openFolder(path: string): Promise<void>;
  openExternalUrl(url: string): Promise<void>;
  getAppVersion(): Promise<string>;

  // --- deep links ----------------------------------------------------------
  // WEB: desktop deep links arrive via the OS (agentkitforge://). On the web the
  // equivalent is initial URL query params + an in-app router; this method is
  // the seam. Returns an unlisten/cleanup function.
  getInitialDeepLinks(): Promise<string[]>;
  onDeepLink(callback: (urls: string[]) => void): Promise<() => void>;

  // --- updater -------------------------------------------------------------
  // WEB: a hosted web app self-updates on reload; there is no Tauri updater.
  // `checkForUpdate` returns the rich Tauri `Update` object whose
  // download()/install() lifecycle the UI drives directly — that object is the
  // most desktop-specific seam and a web build would return null here.
  checkForUpdate(): Promise<Update | null>;
  relaunchApp(): Promise<void>;
}
