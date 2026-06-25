// Desktop implementation of `ForgeClient`.
//
// This is a faithful 1:1 wrapper around the Tauri `invoke()` calls and plugin
// APIs the UI used to call inline. Each method forwards the exact command name
// and args object the UI built before Phase 0, so desktop behavior is
// byte-for-byte unchanged. Do NOT add logic here beyond shaping the args into
// the form the Rust command expects.

import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrent as getCurrentDeepLinks, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

import type {
  AccountAuthConfigDiagnostics,
  AgentKitCandidateInspection,
  AgentKitPackagePreview,
  AgentKitStarterHint,
  AgentKitSummary,
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
import type {
  AddKitToLibraryInput,
  AiProviderInput,
  AiProviderTestResult,
  CheckKitUpdateInput,
  CloudFavoritesResult,
  AddCloudFavoriteInput,
  ExportOneFileInput,
  ExportToClaudeCodeInput,
  ExportToCodexInput,
  FetchLicensedMarketKitInput,
  ForgeClient,
  ImportAgentKitFromGitInput,
  ImportAgentKitPackageInput,
  ImportHostedMarketKitInput,
  GatewayRunInput,
  GatewayRunEvent,
  GatewayRunResult,
  NextVersionResult,
  PackageAgentKitInput,
  SaveAgentKitDraftJsonArgs,
  SaveAppPreferencesInput,
  SaveMarkdownFileArgs,
  SubmitHostedMarketKitInput,
  TestAiProviderInput,
} from "./types";

export class TauriForgeClient implements ForgeClient {
  // --- settings ------------------------------------------------------------
  getAppSettings(): Promise<PublicSettings> {
    return invoke<PublicSettings>("get_app_settings");
  }
  saveAppPreferences(input: SaveAppPreferencesInput): Promise<PublicSettings> {
    return invoke<PublicSettings>("save_app_preferences", { input });
  }
  saveOpenAiApiKey(apiKey: string): Promise<PublicSettings> {
    return invoke<PublicSettings>("save_openai_api_key", { apiKey });
  }
  clearOpenAiApiKey(): Promise<PublicSettings> {
    return invoke<PublicSettings>("clear_openai_api_key");
  }
  saveAiProvider(input: AiProviderInput): Promise<PublicSettings> {
    return invoke<PublicSettings>("save_ai_provider", { input });
  }
  removeAiProvider(providerId: string): Promise<PublicSettings> {
    return invoke<PublicSettings>("remove_ai_provider", { providerId });
  }
  setDefaultAiProvider(providerId: string): Promise<PublicSettings> {
    return invoke<PublicSettings>("set_default_ai_provider", { providerId });
  }
  testAiProviderConnection(input: TestAiProviderInput): Promise<AiProviderTestResult> {
    return invoke<AiProviderTestResult>("test_ai_provider_connection", { input });
  }
  saveUpdateCheckTimestamp(checkedAt: string): Promise<PublicSettings> {
    return invoke<PublicSettings>("save_update_check_timestamp", { checkedAt });
  }

  // --- auth / account ------------------------------------------------------
  checkAgentKitProjectAuthConfig(): Promise<AccountAuthConfigDiagnostics> {
    return invoke<AccountAuthConfigDiagnostics>("check_agentkitproject_auth_config");
  }
  beginAgentKitProjectAccountLogin(): Promise<DeviceLoginStart> {
    return invoke<DeviceLoginStart>("begin_agentkitproject_account_login");
  }
  completeAgentKitProjectAccountLogin(loginId: string): Promise<PublicSettings> {
    return invoke<PublicSettings>("complete_agentkitproject_account_login", { input: { loginId } });
  }
  restoreAgentKitProjectAccount(): Promise<PublicSettings> {
    return invoke<PublicSettings>("restore_agentkitproject_account");
  }
  disconnectAgentKitProjectAccount(): Promise<PublicSettings> {
    return invoke<PublicSettings>("disconnect_agentkitproject_account");
  }

  // --- My Kits library -----------------------------------------------------
  listMyKits(): Promise<MyKitEntry[]> {
    return invoke<MyKitEntry[]>("list_my_kits");
  }
  addKitToLibrary(input: AddKitToLibraryInput): Promise<MyKitEntry> {
    return invoke<MyKitEntry>("add_kit_to_library", { input });
  }
  removeKitFromLibrary(path: string): Promise<RemoveKitFromLibraryResult> {
    return invoke<RemoveKitFromLibraryResult>("remove_kit_from_library", { path });
  }
  refreshKitMetadata(path: string): Promise<MyKitEntry> {
    return invoke<MyKitEntry>("refresh_kit_metadata", { path });
  }
  markLibraryKitUsed(path: string): Promise<void> {
    return invoke("mark_library_kit_used", { path });
  }
  validateLibraryKit(path: string): Promise<ValidationReport> {
    return invoke<ValidationReport>("validate_library_kit", { path, profile: "local-valid" });
  }
  getAgentKitSummary(path: string): Promise<AgentKitSummary> {
    return invoke<AgentKitSummary>("get_agent_kit_summary", { path });
  }
  checkKitUpdate(input: CheckKitUpdateInput): Promise<KitUpdateStatus> {
    return invoke<KitUpdateStatus>("check_kit_update", {
      marketBaseUrl: input.marketBaseUrl,
      slug: input.slug,
      installedVersion: input.installedVersion,
    });
  }

  // --- cloud favorites (opt-in; account-connected only) --------------------
  listCloudFavorites(marketBaseUrl?: string): Promise<CloudFavoritesResult> {
    return invoke<CloudFavoritesResult>("list_cloud_favorites", { marketBaseUrl });
  }
  addCloudFavorite(input: AddCloudFavoriteInput): Promise<CloudFavoritesResult> {
    return invoke<CloudFavoritesResult>("add_cloud_favorite", {
      slug: input.slug,
      kitId: input.kitId,
      marketBaseUrl: input.marketBaseUrl,
    });
  }
  removeCloudFavorite(kitId: string, marketBaseUrl?: string): Promise<void> {
    return invoke<void>("remove_cloud_favorite", { kitId, marketBaseUrl });
  }

  // --- inspect / metadata --------------------------------------------------
  getAgentKitMetadata(rootPath: string): Promise<KitMetadata> {
    return invoke<KitMetadata>("get_agent_kit_metadata", { rootPath });
  }
  getAgentKitStarterHint(rootPath: string): Promise<AgentKitStarterHint | null> {
    return invoke<AgentKitStarterHint | null>("get_agent_kit_starter_hint", { rootPath });
  }
  inspectAgentKitCandidate(path: string): Promise<AgentKitCandidateInspection> {
    return invoke<AgentKitCandidateInspection>("inspect_agent_kit_candidate", { path });
  }
  inspectAgentKitPackage(packagePath: string): Promise<AgentKitPackagePreview> {
    return invoke<AgentKitPackagePreview>("inspect_agent_kit_package", { packagePath });
  }
  nextAgentKitVersion(rootPath: string): Promise<NextVersionResult> {
    return invoke<NextVersionResult>("next_agent_kit_version", { rootPath });
  }

  // --- import --------------------------------------------------------------
  importAgentKitPackage(input: ImportAgentKitPackageInput): Promise<ImportAgentKitPackageResult> {
    return invoke<ImportAgentKitPackageResult>("import_agent_kit_package", { input });
  }
  importAgentKitFromGit(input: ImportAgentKitFromGitInput): Promise<ImportAgentKitFromGitResult> {
    return invoke<ImportAgentKitFromGitResult>("import_agent_kit_from_git", { input });
  }
  importHostedMarketKit(input: ImportHostedMarketKitInput): Promise<ImportAgentKitPackageResult> {
    return invoke<ImportAgentKitPackageResult>("import_hosted_market_kit", { input });
  }
  fetchLicensedMarketKit(input: FetchLicensedMarketKitInput): Promise<FetchLicensedMarketKitResult> {
    return invoke<FetchLicensedMarketKitResult>("fetch_licensed_market_kit", { input });
  }

  // --- build / draft / AI generate ----------------------------------------
  createAgentKitFromTemplate(input: CreateAgentKitInput): Promise<CreateAgentKitResult> {
    return invoke<CreateAgentKitResult>("create_agent_kit_from_template", { input });
  }
  loadAgentKitAsDraft(path: string): Promise<LoadAgentKitAsDraftResult> {
    return invoke<LoadAgentKitAsDraftResult>("load_agent_kit_as_draft", { path });
  }
  renderAgentKitDraft(input: RenderAgentKitDraftInput): Promise<RenderAgentKitDraftResult> {
    return invoke<RenderAgentKitDraftResult>("render_agent_kit_draft", { input });
  }
  renderGeneratedAgentKitDraft(input: {
    draftJson: unknown;
    outputFolder: string;
    force: boolean;
  }): Promise<RenderAgentKitDraftResult> {
    return invoke<RenderAgentKitDraftResult>("render_generated_agent_kit_draft", { input });
  }
  generateAgentKitDraftWithAi(input: GenerateAgentKitDraftInput): Promise<GenerateAgentKitDraftResult> {
    return invoke<GenerateAgentKitDraftResult>("generate_agent_kit_draft_with_ai", { input });
  }
  reviseAgentKitDraftWithAi(input: ReviseAgentKitDraftInput): Promise<GenerateAgentKitDraftResult> {
    return invoke<GenerateAgentKitDraftResult>("revise_agent_kit_draft_with_ai", { input });
  }
  summarizeExampleInputDocuments(paths: string[]): Promise<ExampleInputDocument[]> {
    return invoke<ExampleInputDocument[]>("summarize_example_input_documents", { paths });
  }

  // --- validate ------------------------------------------------------------
  validateAgentKit(args: {
    rootPath?: string;
    path?: string;
    profile: ValidationProfile;
  }): Promise<ValidationReport> {
    return invoke<ValidationReport>("validate_agent_kit", args);
  }

  // --- package / export ----------------------------------------------------
  packageAgentKit(input: PackageAgentKitInput): Promise<PackageAgentKitResult> {
    return invoke<PackageAgentKitResult>("package_agent_kit", { input });
  }
  exportAgentKitOneFile(input: ExportOneFileInput): Promise<ExportAgentKitResult> {
    return invoke<ExportAgentKitResult>("export_agent_kit_onefile", { input });
  }
  exportAgentKitToCodex(input: ExportToCodexInput): Promise<CodexExportResult> {
    return invoke<CodexExportResult>("export_agent_kit_to_codex", { input });
  }
  exportAgentKitToClaudeCode(input: ExportToClaudeCodeInput): Promise<ClaudeCodeExportResult> {
    return invoke<ClaudeCodeExportResult>("export_agent_kit_to_claude_code", { input });
  }

  // --- prepared prompts / use ---------------------------------------------
  listPreparedPrompts(rootPath: string): Promise<PreparedPrompt[]> {
    return invoke<PreparedPrompt[]>("list_prepared_prompts", { rootPath });
  }
  renderPreparedPrompt(input: {
    rootPath: string;
    promptId: string;
    inputValues: Record<string, unknown>;
  }): Promise<PreparedPromptRenderResult> {
    return invoke<PreparedPromptRenderResult>("render_prepared_prompt", { input });
  }
  runAgentKitWithAi(input: Record<string, unknown>): Promise<RunAgentKitResult> {
    return invoke<RunAgentKitResult>("run_agent_kit_with_ai", { input });
  }

  // --- gateway run / chat (Phase 2c-iii) -----------------------------------
  async runAgentKitWithGateway(
    input: GatewayRunInput,
    onEvent: (event: GatewayRunEvent) => void,
  ): Promise<GatewayRunResult> {
    // Subscribe to this run's scoped event channel BEFORE invoking, so no early
    // text/tool events are missed. The Rust command streams JSONL bridge events
    // here; we tear the listener down when the run resolves or rejects.
    const unlisten = await listen<GatewayRunEvent>(
      `gateway://event/${input.runId}`,
      (event) => onEvent(event.payload),
    );
    try {
      return await invoke<GatewayRunResult>("run_agent_kit_with_gateway", { input });
    } finally {
      unlisten();
    }
  }

  // --- market submit -------------------------------------------------------
  submitHostedMarketKit(input: SubmitHostedMarketKitInput): Promise<SubmitHostedMarketKitResult> {
    return invoke<SubmitHostedMarketKitResult>("submit_hosted_market_kit", { input });
  }

  // --- dialogs -------------------------------------------------------------
  // WEB: replace these Tauri native dialogs with <input type="file"> / save
  // pickers in a future web client.
  selectAgentKitFolder(): Promise<string | null> {
    return invoke<string | null>("select_agent_kit_folder");
  }
  selectAgentKitPackageFile(): Promise<string | null> {
    return invoke<string | null>("select_agent_kit_package_file");
  }
  selectJsonFile(): Promise<string | null> {
    return invoke<string | null>("select_json_file");
  }
  selectJsonOutputPath(): Promise<string | null> {
    return invoke<string | null>("select_json_output_path");
  }
  selectOnefileOutputPath(): Promise<string | null> {
    return invoke<string | null>("select_onefile_output_path");
  }
  selectExampleInputDocuments(): Promise<string[]> {
    return invoke<string[]>("select_example_input_documents", { input: { allowMultiple: true } });
  }
  selectForgeResponseOutputPath(fileName: string): Promise<string | null> {
    return invoke<string | null>("select_forge_response_output_path", { fileName });
  }
  selectForgeResponseTextOutputPath(fileName: string): Promise<string | null> {
    return invoke<string | null>("select_forge_response_text_output_path", { fileName });
  }
  saveAgentKitDraftJson(args: SaveAgentKitDraftJsonArgs): Promise<{ filePath: string }> {
    return invoke<{ filePath: string }>("save_agent_kit_draft_json", {
      input: args.input,
      outputPath: args.outputPath,
    });
  }
  saveMarkdownFile(args: SaveMarkdownFileArgs): Promise<{ filePath: string }> {
    return invoke<{ filePath: string }>("save_markdown_file", {
      input: args.input,
      outputPath: args.outputPath,
    });
  }

  // --- shell / misc --------------------------------------------------------
  openFolder(path: string): Promise<void> {
    return invoke("open_folder", { path });
  }
  openExternalUrl(url: string): Promise<void> {
    return invoke("open_external_url", { url });
  }
  getAppVersion(): Promise<string> {
    return getVersion();
  }

  // --- deep links ----------------------------------------------------------
  // WEB: desktop deep links arrive via the OS; a web client reads URL params.
  async getInitialDeepLinks(): Promise<string[]> {
    const urls = await getCurrentDeepLinks();
    return urls ?? [];
  }
  onDeepLink(callback: (urls: string[]) => void): Promise<() => void> {
    return onOpenUrl(callback);
  }

  // --- updater -------------------------------------------------------------
  // WEB: no Tauri updater on the web; a web client returns null here.
  checkForUpdate(): Promise<Update | null> {
    return check();
  }
  relaunchApp(): Promise<void> {
    return relaunch();
  }
}
