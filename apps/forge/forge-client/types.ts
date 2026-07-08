// Phase 2 of the AgentKitForge WebApp port.
//
// This file REPLICATES the `ForgeClient` interface from the desktop repo
// (`agentkitforge-app/src/forge-client/types.ts`). We replicate rather than
// import because the desktop type module statically imports
// `@tauri-apps/plugin-updater` (for the `Update` type) and pulls its result
// types from the 11977-line `App.tsx` — neither of which is installable or
// importable cleanly from the web package. Keep the METHOD SIGNATURES in sync
// with the desktop interface; the result payloads are intentionally widened to
// structural shapes (the web UI only reads a subset of fields).
//
// IMPORTANT: this is a client module. `@agentkitforge/core` is Node-only and is
// never imported here — the client only talks HTTP to /api/*.

export type ValidationProfile = "local-valid" | "publishable" | "trusted" | "verified";

// --- widened result shapes (subset of the desktop App.tsx types) -------------
// These are intentionally loose: the web backend returns JSON envelopes and the
// UI reads only a few fields. `[key: string]: unknown` keeps them forward-
// compatible with the richer desktop shapes.
export type PublicSettings = Record<string, unknown>;
export type AccountAuthConfigDiagnostics = Record<string, unknown>;
export type DeviceLoginStart = { loginId: string; verificationUri?: string; userCode?: string; [k: string]: unknown };
export type KitMetadata = { kitId?: string; name?: string; [k: string]: unknown };
export type MyKitEntry = {
  // Web backend KitMetadataRecord shape (path === kitId on the web).
  kitId: string;
  ownerUserId?: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  source?: string;
  [k: string]: unknown;
};
export type ValidationReport = {
  valid?: boolean;
  ok?: boolean;
  profile?: ValidationProfile;
  errors?: Array<{ message: string; [k: string]: unknown } | string>;
  warnings?: Array<{ message: string; [k: string]: unknown } | string>;
  // Core `validateAgentKit` report shape: a single severity-tagged issues list.
  issues?: Array<{ severity?: string; code?: string; message?: string; path?: string }>;
  [k: string]: unknown;
};
export type AgentKitSummary = Record<string, unknown>;
export type AgentKitStarterHint = Record<string, unknown>;
export type AgentKitCandidateInspection = Record<string, unknown>;
export type AgentKitPackagePreview = Record<string, unknown>;
export type AgentKitTemplate = Record<string, unknown>;
export type KitUpdateStatus = Record<string, unknown>;
export type CreateAgentKitResult = { kitId?: string; [k: string]: unknown };
export type RemoveKitFromLibraryResult = { ok?: boolean; [k: string]: unknown };
export type ImportAgentKitPackageResult = { kit?: MyKitEntry; kitId?: string; [k: string]: unknown };
export type ImportAgentKitFromGitResult = { kit?: MyKitEntry; kitId?: string; [k: string]: unknown };
export type FetchLicensedMarketKitResult = {
  onlineOnly?: boolean;
  downloadable?: boolean;
  pricing?: unknown;
  kitId?: string;
  fileName?: string;
  sha256?: string;
  preview?: { files: string[]; texts: Record<string, string> };
  [k: string]: unknown;
};
export type LoadAgentKitAsDraftResult = { draft?: unknown; [k: string]: unknown };
export type RenderAgentKitDraftResult = { kit?: MyKitEntry; kitId?: string; [k: string]: unknown };
export type GenerateAgentKitDraftResult = Record<string, unknown>;
export type GenerateAgentKitDraftInput = { userRequest?: string; [k: string]: unknown };
export type ReviseAgentKitDraftInput = { session?: unknown; changeRequest?: string; [k: string]: unknown };
export type RenderAgentKitDraftInput = Record<string, unknown>;
export type CreateAgentKitInput = {
  template: string;
  id: string;
  name: string;
  description: string;
  [k: string]: unknown;
};
export type ExampleInputDocument = Record<string, unknown>;
export type PreparedPrompt = { id: string; name?: string; [k: string]: unknown };
export type PreparedPromptRenderResult = Record<string, unknown>;
export type RunAgentKitResult = Record<string, unknown>;
export type PackageAgentKitResult = { filePath?: string; bytes?: Uint8Array; fileName?: string; [k: string]: unknown };
export type ExportAgentKitResult = { filePath?: string; text?: string; fileName?: string; [k: string]: unknown };
export type CodexExportResult = { fileName?: string; bytes?: Uint8Array; [k: string]: unknown };
export type ClaudeCodeExportResult = { fileName?: string; bytes?: Uint8Array; [k: string]: unknown };
export type KitLibrarySource = string;
// On the web there is no Tauri updater `Update` object.
export type Update = unknown;

// --- argument payloads (mirror the desktop interface) ------------------------
export type AddKitToLibraryInput = { path: string; source: KitLibrarySource | string; [key: string]: unknown };
export type ImportAgentKitPackageInput = {
  packagePath: string;
  destinationRootFolder: string;
  validationProfile: ValidationProfile;
  force: boolean;
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
export type ExportOneFileInput = { rootPath: string; outputPath: string };
export type ExportToClaudeCodeInput = { kitPath: string; destinationDir: string; force: boolean };
export type ExportToCodexInput = { kitPath: string; destinationSkillsDir: string; force: boolean };
export type PackageAgentKitInput = { rootPath: string; outputFolder: string };
export type SubmitHostedMarketKitInput = { rootPath: string; marketBaseUrl: string; validationProfile: ValidationProfile };
export type SubmitHostedMarketKitResult = Record<string, unknown>;
export type SaveAgentKitDraftJsonArgs = { input: { draftJson: unknown }; outputPath: string };
export type SaveMarkdownFileArgs = { input: { content: string }; outputPath: string };
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
export type TestAiProviderInput = { providerId: string | undefined; model: string };
export type CheckKitUpdateInput = { marketBaseUrl?: string; slug?: string; installedVersion?: string };
export type AiProviderTestResult = { ok: boolean; model: string; message: string };
export type NextVersionResult = { previous: string; next: string };

/**
 * The single typed transport surface between the UI and the backend.
 * Method signatures MUST match the desktop `ForgeClient` (kept in sync by hand).
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
  validateAgentKit(args: { rootPath?: string; path?: string; profile: ValidationProfile }): Promise<ValidationReport>;

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
  /**
   * End a gateway streaming session (cleanup on unmount/end). Optional: the
   * desktop client manages session lifetime differently; the web client
   * implements it to DELETE the gateway session. Fire-and-forget.
   */
  endAgentKitSession?(sessionId: string): Promise<void>;

  // --- market submit -------------------------------------------------------
  submitHostedMarketKit(input: SubmitHostedMarketKitInput): Promise<SubmitHostedMarketKitResult>;

  // --- dialogs (file pickers / save paths) --------------------------------
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
  openFolder(path: string): Promise<void>;
  openExternalUrl(url: string): Promise<void>;
  getAppVersion(): Promise<string>;

  // --- deep links ----------------------------------------------------------
  getInitialDeepLinks(): Promise<string[]>;
  onDeepLink(callback: (urls: string[]) => void): Promise<() => void>;

  // --- updater -------------------------------------------------------------
  checkForUpdate(): Promise<Update | null>;
  relaunchApp(): Promise<void>;
}
