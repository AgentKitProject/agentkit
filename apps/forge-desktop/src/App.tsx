import {
  Box,
  CheckCircle2,
  FileArchive,
  FolderOutput,
  FolderOpen,
  GitBranch,
  Hammer,
  Info,
  Plug,
  KeyRound,
  MessageSquare,
  PackageOpen,
  PlayCircle,
  Settings,
  Sparkles,
  Star,
  StarOff,
  UploadCloud,
  UserCircle,
} from "lucide-react";
import { type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useMemo, useState } from "react";
import { AppShell, SidebarAccount } from "@agentkitforge/ui";
import { getForgeClient } from "./forge-client";
import type {
  CloudFavorite,
  GatewayRunEvent,
  GatewayRunResult,
} from "./forge-client";
import {
  aiProviderTypes,
  getDefaultModelForProvider,
  getKnownModelsForProvider,
  getProviderCapabilities,
  isApiKeyRequiredForProvider,
  isBaseUrlRequiredForProvider,
  normalizeBaseUrl,
  providerSupportsStructuredJson,
} from "@agentkitforge/core/dist/providers/catalog.js";
import type { AiProviderType } from "@agentkitforge/core/dist/providers/types.js";
import agentKitForgeIcon from "./assets/brand/agentkitforge-icon.svg";
import {
  agentKitProjectUrls,
  canUseAuto,
  canUseHostedMarketBrowse,
  canUseLocalForgeFeatures,
  canUseManualMarketImport,
  canUseManualPackageImport,
  canUseMarketSubmit,
  defaultExternalServiceConnections,
  disconnectedAccountConnection,
  type AccountConnection,
} from "./integrations";

// Phase 0: all backend access goes through the typed ForgeClient transport
// rather than calling Tauri invoke()/plugin APIs directly, so the UI is
// retargetable (desktop=invoke today, web=fetch later).
const forge = getForgeClient();

type SectionId = "my-kits" | "import" | "build" | "use" | "validate" | "settings";
type ExtendedSectionId = SectionId | "package-export" | "market-submit" | "install-targets" | "run-chat" | "account" | "about";
export type ValidationProfile = "local-valid" | "publishable" | "trusted" | "verified";
export type ValidationIssueSeverity = "error" | "warning";
export type AgentKitTemplate = "blank" | "financial-review";

export type DeviceLoginStart = {
  loginId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
};

export type AccountAuthConfigDiagnostics = {
  configured: boolean;
  missingPublicConfigKeys: string[];
  clientIdSource?: string;
  profileBaseUrl: string;
  marketBaseUrl: string;
  forgeBaseUrl: string;
  deviceAuthorizationEndpoint: string;
};
export type ThemeMode = "light" | "dark";
type BuildTabId = "ai" | "guided" | "template" | "draft" | "edit-ai" | "guided-edit";
type BuildModeGroup = "Create New" | "Edit Existing";
type ImportTabId = "zip" | "folder" | "git" | "market" | "org";
type InstallTargetTab = "codex" | "claude-code";
type UsePromptMode = "prepared" | "custom";
type UpdateStatus = "idle" | "up-to-date" | "checking" | "available" | "downloading" | "installing" | "failed";

export type AiProviderConfig = {
  id: string;
  name: string;
  providerType: AiProviderType;
  baseUrl?: string;
  hasApiKey: boolean;
  model?: string;
  defaultModel: string;
  supportsStructuredJson: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AiProviderForm = {
  id?: string;
  name: string;
  providerType: AiProviderType;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  supportsStructuredJson: boolean;
};

type AppState = {
  currentKitPath: string;
  currentKitName: string;
  defaultOutputFolder: string;
  openAiApiKey: string;
  preferredValidationProfile: ValidationProfile;
};

export type KitMetadata = {
  id: string;
  name: string;
  version: string;
  description?: string;
};

export type ValidationIssue = {
  severity: ValidationIssueSeverity;
  code: string;
  message: string;
  path?: string;
};

export type ValidationReport = {
  valid: boolean;
  profile: ValidationProfile;
  rootPath: string;
  issues: ValidationIssue[];
};

export type PromptInputValidationReport = {
  valid: boolean;
  issues: ValidationIssue[];
};

export type CreateAgentKitResult = {
  rootPath: string;
  template: AgentKitTemplate;
  files: string[];
};

export type RenderAgentKitDraftResult = {
  rootPath: string;
  files: string[];
};

export type RenderAgentKitDraftInput = {
  draftFilePath: string;
  outputFolder: string;
  force: boolean;
};

export type GenerateAgentKitDraftInput = {
  userRequest: string;
  targetUsers: string;
  domain: string;
  desiredValidationLevel: ValidationProfile;
  constraints: string;
  sourceNotes: string;
  requestedSections: string[];
  excludedSections: string[];
  exampleInputDocuments: ExampleInputDocument[];
  providerId: string;
  model: string;
};

export type GenerateAgentKitDraftResult = {
  draftJson: unknown;
  draftJsonPretty: string;
  warnings: string[];
  providerId: string;
  providerName: string;
  model: string;
  rawResponse?: string;
  session?: AgentKitDraftSession;
  currentRevision?: AgentKitDraftRevision;
};

export type AgentKitDraftRevision = {
  id: string;
  version: number;
  draft: unknown;
  changeRequest?: string;
  provider?: string;
  model?: string;
  warnings?: string[];
  createdAt: string;
};

export type AgentKitDraftSession = {
  id: string;
  name: string;
  originalRequest: string;
  currentRevisionId: string;
  revisions: AgentKitDraftRevision[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
};

export type ReviseAgentKitDraftInput = {
  session: AgentKitDraftSession;
  changeRequest: string;
  desiredValidationLevel: ValidationProfile;
  constraints: string;
  sourceNotes: string;
  requestedSections: string[];
  excludedSections: string[];
  exampleInputDocuments: ExampleInputDocument[];
  providerId: string;
  model: string;
};

export type ExampleInputDocument = {
  id: string;
  name: string;
  filename: string;
  mediaType?: string;
  kind: "text" | "markdown" | "csv" | "spreadsheet";
  extractedText?: string;
  tablePreview?: string[][];
  notes?: string;
  path?: string;
};

export type LoadAgentKitAsDraftResult = {
  draft: unknown;
  warnings: string[];
  sourceFiles: string[];
};

export type CreateAgentKitInput = {
  outputFolder: string;
  id: string;
  name: string;
  description: string;
  template: AgentKitTemplate;
  force: boolean;
};

export type ExportAgentKitResult = {
  filePath: string;
};

export type PackageAgentKitResult = {
  artifactPath: string;
  artifactType: string;
};

export type SubmitHostedMarketKitResult = {
  submissionId: string;
  status: string;
  marketLink: string;
  packagePath: string;
  packageSha256: string;
  validationReport: ValidationReport;
};

type ArtifactResult = {
  artifactPath: string;
  artifactType: ".agentkit.zip" | ".onefile.md";
};

export type KitLibrarySource = "built" | "imported" | "local_import" | "market" | "manual" | "unknown";

export type MyKitEntry = {
  id: string;
  name: string;
  version: string;
  description?: string;
  path: string;
  source: KitLibrarySource;
  sourceLabel?: string;
  lastValidatedAt?: string;
  lastValidatedProfile?: ValidationProfile;
  lastValidationValid?: boolean;
  lastUsedAt?: string;
  importedAt?: string;
  installedAt?: string;
  packageFileName?: string;
  packageSizeBytes?: number;
  sha256?: string;
  marketBaseUrl?: string;
  schemaVersion?: string;
  sourceMarketSlug?: string;
  sourceMarketKitId?: string;
  sourceUrl?: string;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
  pathExists: boolean;
};

export type KitUpdateStatus = {
  available: boolean;
  latestVersion?: string;
  updateAvailable: boolean;
  reason?: "ok" | "not_found" | "unavailable" | "error";
};

export type RemoveKitFromLibraryResult = {
  removedFromLibrary: boolean;
  deletedLocalFiles: boolean;
};

export type AgentKitSummary = {
  id: string;
  name: string;
  version: string;
  description?: string;
  domain?: string;
  targetUsers?: string[] | string;
  validationStatus?: "valid" | "invalid";
  counts?: Record<string, number>;
  lists?: Record<string, unknown[]>;
  paths?: {
    rootPath?: string;
    manifestPath?: string;
  };
  warnings?: string[];
};

export type ImportAgentKitPackageResult = {
  extractedPath: string;
  validationReport: ValidationReport;
  metadata: MyKitEntry;
  packageMetadata: PackageImportMetadata;
  duplicateWarnings: ImportDuplicateWarning[];
  files: string[];
};

export type LicensedKitPreview = {
  files: string[];
  texts: Record<string, string>;
};

export type FetchLicensedMarketKitResult = {
  onlineOnly: boolean;
  pricing: string;
  downloadable: boolean;
  kitId: string;
  sha256: string;
  preview: LicensedKitPreview;
  // Present only for downloadable paid kits the user owns (saved to My Kits).
  imported: ImportAgentKitPackageResult | null;
  message: string;
};

type HostedMarketImportPhase =
  | "idle"
  | "requesting"
  | "downloading"
  | "verifying"
  | "importing"
  | "validating"
  | "success"
  | "failed";

type MarketSubmitPhase =
  | "idle"
  | "validating"
  | "packaging"
  | "uploading"
  | "creating"
  | "submitted"
  | "failed";

type MarketSubmissionStatus =
  | "pending"
  | "validating"
  | "validation_failed"
  | "approved"
  | "rejected"
  | "published"
  | "canceled"
  | "removed"
  | "deleted"
  | "expired"
  | "archived";

export type MarketIdentifierKind = "kit" | "kitId";

export type MarketImportRequest = {
  id: string;
  marketBaseUrl: string;
  identifier: string;
  identifierKind: MarketIdentifierKind;
  source: "manual" | "deep-link";
  requiresConfirmation: boolean;
};

export type PackageImportMetadata = {
  kitId?: string;
  kitName?: string;
  version?: string;
  schemaVersion?: string;
  source?: string;
  sourceLabel?: string;
  importedAt?: string;
  packageFileName?: string;
  packageSizeBytes?: number;
  sha256?: string;
  marketBaseUrl?: string;
  sourceMarketSlug?: string;
  sourceMarketKitId?: string;
  sourceUrl?: string;
  publishedAt?: string;
};

export type ImportDuplicateWarning = {
  id: string;
  name: string;
  version: string;
  path: string;
};

export type AgentKitPackagePreview = {
  packagePath: string;
  packageMetadata: PackageImportMetadata;
  duplicateWarnings: ImportDuplicateWarning[];
  foundFiles: string[];
};

export type AgentKitCandidateInspection = {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  looksLikeAgentKit: boolean;
  missingRequiredFiles: string[];
  missingRequiredFolders: string[];
  foundFiles: string[];
  foundSkills: string[];
  recommendedFixes: string[];
  validationReport?: ValidationReport;
  friendlySummary: string;
};

export type ImportAgentKitFromGitResult = {
  repositoryUrl: string;
  importedPath?: string;
  validationReport?: ValidationReport;
  metadata?: MyKitEntry;
  inspection: AgentKitCandidateInspection;
  files: string[];
  warnings: string[];
};

export type CodexExportResult = {
  destinationSkillsDir: string;
  exportedSkillFolders: string[];
  generatedIndexFolder?: string;
  warnings: string[];
};

export type ClaudeCodeExportResult = {
  destinationDir: string;
  pluginFolder: string;
  pluginManifestPath: string;
  exportedSkillFolders: string[];
  warnings: string[];
};

export type PublicSettings = {
  hasOpenaiApiKey: boolean;
  defaultModel: string;
  aiProviders: AiProviderConfig[];
  defaultAiProviderId?: string;
  defaultOutputFolder: string;
  preferredValidationProfile: ValidationProfile;
  preferredContextMode: AgentKitContextMode;
  theme: ThemeMode;
  includePolicies: boolean;
  includeTemplates: boolean;
  includeWorkflows: boolean;
  includeReferences: boolean;
  lastUpdateCheckAt?: string;
  settingsPath: string;
  accountConnection: AccountConnection;
};

type AppUpdateState = {
  status: UpdateStatus;
  update: Update | null;
  lastCheckedAt?: string;
  message?: string;
  error?: string;
  downloadedBytes?: number;
  totalBytes?: number;
};

export type RunAgentKitResult = {
  response: string;
  providerId: string;
  providerName: string;
  model: string;
  kitName?: string;
  context: AgentKitContextDetails;
};

export type AgentKitStarterHint = {
  sourceFile: string;
  excerpt: string;
};

export type PreparedPromptInputType =
  | "short-text"
  | "long-text"
  | "choice"
  | "multi-choice"
  | "date"
  | "number"
  | "boolean";

export type PreparedPromptInput = {
  id: string;
  label: string;
  description?: string;
  type: PreparedPromptInputType;
  required: boolean;
  placeholder?: string;
  defaultValue?: unknown;
  choices?: string[];
  includeInPrompt?: boolean;
};

export type PreparedPrompt = {
  id: string;
  name: string;
  description: string;
  template: string;
  inputs: PreparedPromptInput[];
  outputMode?: "text" | "markdown" | "document";
  documentLikeOutput?: boolean;
  suggestedFileName?: string;
  tags?: string[];
};

export type PreparedPromptRenderResult = {
  prompt: PreparedPrompt;
  validationReport: PromptInputValidationReport;
  renderedPrompt?: string | null;
};

export type AgentKitContextMode = "all" | "triggered";
export type AgentKitContextTarget = "openai" | "chatgpt" | "claude" | "generic";

export type AgentKitContextDetails = {
  includedFiles: string[];
  includedSkills: string[];
  warnings: string[];
  approximateContextLength: number;
};

type GuidedBuilderStep =
  | "basics"
  | "skills"
  | "policies"
  | "outputs"
  | "prompts"
  | "examples"
  | "review";

type GuidedSkill = {
  id: string;
  name: string;
  description: string;
  triggers: string;
  useWhen: string;
  doNotUseWhen: string;
  inputs: string;
  procedure: string;
  output: string;
  riskLevel: string;
};

type GuidedGuardrail = {
  id: string;
  text: string;
};

type GuidedRequiredInput = {
  id: string;
  label: string;
  description: string;
  required: boolean;
  inputType: PreparedPromptInputType;
  placeholder: string;
  defaultValue: string;
  includeInPrompt: boolean;
  choices: string;
};

type GuidedPreparedPrompt = {
  id: string;
  name: string;
  description: string;
  template: string;
  inputs: GuidedRequiredInput[];
  outputMode: "text" | "markdown" | "document";
  documentLikeOutput: boolean;
  suggestedFileName: string;
  tags: string;
};

type GuidedExample = {
  id: string;
  promptId: string;
  prompt: string;
  inputExamples: string;
  output: string;
};

type GuidedBuilderState = {
  name: string;
  id: string;
  description: string;
  domain: string;
  targetUsers: string;
  validationLevel: ValidationProfile;
  outputFolder: string;
  skills: GuidedSkill[];
  guardrails: GuidedGuardrail[];
  outputSections: string;
  outputTemplate: string;
  documentLike: boolean;
  downloadFileName: string;
  summaryStyle: string;
  preparedPrompts: GuidedPreparedPrompt[];
  examples: GuidedExample[];
  force: boolean;
};

type NavItem = {
  id: ExtendedSectionId;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
};

const validationProfiles: ValidationProfile[] = ["local-valid", "publishable", "trusted", "verified"];
const contextModes: AgentKitContextMode[] = ["all", "triggered"];
const contextTargets: AgentKitContextTarget[] = ["openai", "chatgpt", "claude", "generic"];
const agentKitTemplates: AgentKitTemplate[] = ["blank", "financial-review"];
const buildModes: {
  id: BuildTabId;
  group: BuildModeGroup;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  title: string;
  description: string;
  bestFor: string;
}[] = [
  {
    id: "ai",
    group: "Create New",
    icon: Sparkles,
    title: "Build with AI",
    description: "Describe the kit you want, revise the draft, then save when ready.",
    bestFor: "Fastest start",
  },
  {
    id: "guided",
    group: "Create New",
    icon: Hammer,
    title: "Guided Builder",
    description: "Create a kit step by step with forms and prepared prompts.",
    bestFor: "No-code manual build",
  },
  {
    id: "template",
    group: "Create New",
    icon: Box,
    title: "From Template",
    description: "Start from a simple built-in template.",
    bestFor: "Known starter kit",
  },
  {
    id: "draft",
    group: "Create New",
    icon: FileArchive,
    title: "From Draft JSON",
    description: "Render an existing AgentKitDraft JSON file.",
    bestFor: "Advanced",
  },
  {
    id: "edit-ai",
    group: "Edit Existing",
    icon: Sparkles,
    title: "Edit with AI",
    description: "Load a kit from My Kits, request changes, and save an updated draft.",
    bestFor: "Iterative updates",
  },
  {
    id: "guided-edit",
    group: "Edit Existing",
    icon: Hammer,
    title: "Guided Editor",
    description: "Load an existing kit into the form builder and edit without touching files.",
    bestFor: "Careful manual edits",
  },
];
const guidedSteps: { id: GuidedBuilderStep; label: string; badge?: "Required" | "Recommended" | "Optional" }[] = [
  { id: "basics", label: "Basics" },
  { id: "skills", label: "Skills" },
  { id: "policies", label: "Policies", badge: "Optional" },
  { id: "outputs", label: "Outputs / Templates", badge: "Optional" },
  { id: "prompts", label: "Prepared Prompts", badge: "Recommended" },
  { id: "examples", label: "Examples", badge: "Optional" },
  { id: "review", label: "Review & Create" },
];
const requiredBuildSections = ["basics", "skills"];
const buildSectionOptions = [
  { id: "basics", label: "Basics", required: true, help: "Kit name, description, domain, and target users." },
  { id: "skills", label: "Skills", required: true, help: "The tasks this Agent Kit can perform." },
  { id: "preparedPrompts", label: "Prepared Prompts", recommended: true, help: "Reusable prompts users can run later. Recommended, but custom prompts still work without them." },
  { id: "policies", label: "Policies", help: "Guardrails for what the AI should avoid, require, or escalate." },
  { id: "templates", label: "Templates / Outputs", help: "Expected output shapes and reusable templates." },
  { id: "examples", label: "Examples", help: "Good prompt and output examples." },
  { id: "workflows", label: "Workflows", help: "Step-by-step repeatable processes." },
  { id: "references", label: "References", help: "Reference notes or source material." },
  { id: "evals", label: "Evals", help: "Checks that can be used to test kit quality." },
  { id: "scripts", label: "Scripts", advanced: true, help: "Advanced helper scripts. Avoid unless the kit really needs code." },
];
const knownDomains = [
  "Finance / Accounting",
  "Legal",
  "Healthcare / Medical",
  "DevOps / SRE",
  "Cloud / Infrastructure",
  "Security",
  "Software Engineering",
  "Data / Analytics",
  "Sales / Marketing",
  "Customer Support",
  "Research",
  "Education",
  "Operations",
  "General Business",
  "Personal Productivity",
  "Real Estate",
  "HR / Recruiting",
  "Procurement",
  "Compliance",
  "Product Management",
  "Project Management",
  "Writing / Editing",
  "Design / Creative",
  "Insurance",
  "Government / Public Policy",
  "Construction / Trades",
  "Logistics / Supply Chain",
  "Manufacturing",
  "Retail / E-commerce",
  "Nonprofit",
  "Other / Custom",
];
const starterPrompt =
  "Use the attached Agent Kit instructions to help with this task. Follow the kit's skill routing, guardrails, procedures, and output expectations. Ask clarifying questions if required inputs are missing.";
const defaultRuntimeModel = getDefaultModelForProvider("openai") ?? "gpt-5.4-mini";
const appVersion = "0.2.1";
const updateCheckIntervalMs = 24 * 60 * 60 * 1000;

function isDuplicateVersionError(message: string | null | undefined): boolean {
  if (!message) {
    return false;
  }
  return message.toLowerCase().includes("already has an active submission for this kit/version");
}

// The Slice-1 online-only directive code (from @agentkitforge/contracts /
// @agentkitforge/core market): a protected (output-only) kit refuses content
// with a 402 carrying this code instead of bytes.
const ONLINE_ONLY_RUN_REQUIRED = "online_only_run_required";

/** True when a caught error is the Slice-1 online-only / output-only refusal
 *  (the OnlineOnlyContentRefusedError from core, or a 402 with its code). */
function isOnlineOnlyRefusal(error: unknown, message: string | null | undefined): boolean {
  if (error && typeof error === "object") {
    const e = error as { name?: unknown; code?: unknown; onlineOnly?: unknown };
    if (e.name === "OnlineOnlyContentRefusedError") return true;
    if (e.code === ONLINE_ONLY_RUN_REQUIRED) return true;
    if (e.onlineOnly === true) return true;
  }
  return Boolean(message && message.includes(ONLINE_ONLY_RUN_REQUIRED));
}

/** Best-effort pull of a kitId from an online-only refusal directive, if present. */
function extractOnlineOnlyKitId(error: unknown): string | undefined {
  if (error && typeof error === "object") {
    const directive = (error as { directive?: { kitId?: unknown } }).directive;
    if (directive && typeof directive.kitId === "string") return directive.kitId;
  }
  return undefined;
}

/**
 * Build a "run online" handoff URL for an output-only kit. Canonical shapes:
 *   web Forge: `${forge}/forge?kit=market:<slug>&kitId=<id>`
 *   Auto:      `${auto}/?kit=market:<slug>&kitId=<id>`
 * Only the public slug + id are ever passed — never kit content.
 */
function buildRunOnlineUrl(
  base: string,
  path: string,
  slug: string | null,
  kitId: string | null | undefined,
): string {
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  url.searchParams.set("kit", `market:${slug ?? ""}`);
  if (kitId) url.searchParams.set("kitId", kitId);
  return url.toString();
}

function formatDisplayVersion(version: string | number | null | undefined): string {
  const raw = version == null ? "" : String(version).trim();
  if (raw === "") {
    return "";
  }
  return raw.startsWith("v") ? raw : `v${raw}`;
}
const marketSubmissionStatusLabels: Record<MarketSubmissionStatus, string> = {
  pending: "Pending review",
  validating: "Validating",
  validation_failed: "Validation failed",
  approved: "Approved",
  rejected: "Rejected",
  published: "Published",
  canceled: "Canceled",
  removed: "Removed",
  deleted: "Deleted",
  expired: "Expired",
  archived: "Archived",
};

const navItems: NavItem[] = [
  { id: "my-kits", label: "My Kits", icon: PackageOpen },
  { id: "build", label: "Build", icon: Hammer },
  { id: "use", label: "Use", icon: PlayCircle },
  { id: "run-chat" as ExtendedSectionId, label: "Run / Chat", icon: MessageSquare },
  { id: "import", label: "Import", icon: FileArchive },
  { id: "package-export" as ExtendedSectionId, label: "Package / Export", icon: FolderOutput },
  { id: "market-submit" as ExtendedSectionId, label: "Submit to Market", icon: UploadCloud },
  { id: "install-targets", label: "Install on Local Agent", icon: Plug },
  { id: "account", label: "Account", icon: UserCircle },
  { id: "settings", label: "Settings", icon: Settings },
];

const secondarySectionTitles: Partial<Record<ExtendedSectionId, string>> = {
  validate: "Validate Kit",
  "market-submit": "Submit to Market",
};

function buildModeGroupForTab(tabId: BuildTabId): BuildModeGroup {
  return buildModes.find((mode) => mode.id === tabId)?.group ?? "Create New";
}

function formatByteCount(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function updateStatusLabel(status: UpdateStatus) {
  switch (status) {
    case "up-to-date":
      return "Up to date";
    case "checking":
      return "Checking";
    case "available":
      return "Update available";
    case "downloading":
      return "Downloading";
    case "installing":
      return "Installing";
    case "failed":
      return "Update failed";
    default:
      return "Not checked yet";
  }
}

function formatUpdateTimestamp(value?: string) {
  if (!value) {
    return "Not checked yet";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function accountStatusLabel(accountConnection: AccountConnection) {
  switch (accountConnection.accountConnectionStatus) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "error":
      return "Error";
    default:
      return "Not connected";
  }
}

function accountDisplayName(accountConnection: AccountConnection) {
  return accountConnection.userDisplayName || accountConnection.userHandle || "";
}

function accountInitials(accountConnection: AccountConnection) {
  if (accountConnection.avatarInitials?.trim()) {
    return accountConnection.avatarInitials.trim();
  }
  const displayValue = accountDisplayName(accountConnection);
  if (!displayValue.trim()) {
    return "";
  }

  return displayValue
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

type MarketImportParseResult =
  | { ok: true; request: MarketImportRequest }
  | { ok: false; error: string };

function parseMarketImportDeepLink(rawUrl: string): MarketImportParseResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Market import link is invalid." };
  }
  if (url.protocol !== "agentkitforge:" || url.hostname !== "market" || url.pathname !== "/import") {
    return { ok: false, error: "Market import link route is not supported." };
  }
  const blockedParam = blockedMarketImportParam(url.searchParams);
  if (blockedParam) {
    return { ok: false, error: `Market import links cannot include ${blockedParam}.` };
  }
  const market = url.searchParams.get("market")?.trim() || "";
  const kit = url.searchParams.get("kit")?.trim() || "";
  const kitId = url.searchParams.get("kitId")?.trim() || "";
  if (!market) {
    return { ok: false, error: "Market import link is missing the market URL." };
  }
  if (!kit && !kitId) {
    return { ok: false, error: "Market import link is missing a kit identifier." };
  }
  const marketValidation = normalizeMarketBaseUrl(market);
  if (!marketValidation.ok) {
    return { ok: false, error: marketValidation.error };
  }
  return {
    ok: true,
    request: {
      id: `deep-link-${Date.now()}`,
      marketBaseUrl: marketValidation.marketBaseUrl,
      identifier: kitId || kit,
      identifierKind: kitId ? "kitId" : "kit",
      source: "deep-link",
      requiresConfirmation: true,
    },
  };
}

function normalizeMarketImportReference(
  rawReference: string,
  fallbackMarketBaseUrl: string,
): MarketImportParseResult {
  const reference = rawReference.trim();
  if (!reference) {
    return { ok: false, error: "Enter a Market kit URL, slug, or ID before importing." };
  }

  try {
    const url = new URL(reference);
    const marketValidation = normalizeMarketBaseUrl(url.origin);
    if (!marketValidation.ok) {
      return { ok: false, error: marketValidation.error };
    }
    const pathParts = url.pathname.split("/").filter(Boolean);
    const kitsIndex = pathParts.indexOf("kits");
    const kitFromPath = kitsIndex >= 0 ? pathParts[kitsIndex + 1] : pathParts[pathParts.length - 1];
    const kitId = url.searchParams.get("kitId")?.trim() || "";
    const kit = url.searchParams.get("kit")?.trim() || kitFromPath || "";
    if (!kit && !kitId) {
      return { ok: false, error: "Market kit URL is missing a kit slug or ID." };
    }
    const blockedParam = blockedMarketImportParam(url.searchParams);
    if (blockedParam) {
      return { ok: false, error: `Market import URLs cannot include ${blockedParam}.` };
    }
    return {
      ok: true,
      request: {
        id: `manual-${Date.now()}`,
        marketBaseUrl: marketValidation.marketBaseUrl,
        identifier: kitId || kit,
        identifierKind: kitId ? "kitId" : "kit",
        source: "manual",
        requiresConfirmation: false,
      },
    };
  } catch {
    const marketValidation = normalizeMarketBaseUrl(fallbackMarketBaseUrl);
    if (!marketValidation.ok) {
      return { ok: false, error: marketValidation.error };
    }
    return {
      ok: true,
      request: {
        id: `manual-${Date.now()}`,
        marketBaseUrl: marketValidation.marketBaseUrl,
        identifier: reference,
        identifierKind: "kit",
        source: "manual",
        requiresConfirmation: false,
      },
    };
  }
}

function blockedMarketImportParam(searchParams: URLSearchParams) {
  for (const key of searchParams.keys()) {
    const normalized = key.toLowerCase();
    if (
      normalized === "downloadurl" ||
      normalized.includes("token") ||
      normalized.includes("auth") ||
      normalized.includes("secret") ||
      normalized.includes("adminkey") ||
      normalized.includes("servicekey") ||
      normalized === "key" ||
      normalized === "apikey" ||
      normalized === "access_key"
    ) {
      return key;
    }
  }
  return null;
}

function normalizeMarketBaseUrl(rawMarket: string): { ok: true; marketBaseUrl: string } | { ok: false; error: string } {
  let marketUrl: URL;
  try {
    marketUrl = new URL(rawMarket.trim());
  } catch {
    return { ok: false, error: "Market URL is invalid." };
  }
  if (marketUrl.username || marketUrl.password) {
    return { ok: false, error: "Market URL must not include credentials." };
  }
  if (marketUrl.protocol !== "https:" && !(marketUrl.protocol === "http:" && isLocalDevHost(marketUrl.hostname))) {
    return { ok: false, error: "Market URL must use HTTPS unless it is localhost for development." };
  }
  marketUrl.pathname = "";
  marketUrl.search = "";
  marketUrl.hash = "";
  return { ok: true, marketBaseUrl: marketUrl.toString().replace(/\/$/, "") };
}

function isLocalDevHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
}

function isHostedAgentKitMarket(marketBaseUrl: string) {
  const normalized = normalizeMarketBaseUrl(marketBaseUrl);
  return normalized.ok && normalized.marketBaseUrl === agentKitProjectUrls.market;
}

export function App() {
  const [activeSection, setActiveSection] = useState<ExtendedSectionId>("my-kits");
  const [settings, setSettings] = useState<PublicSettings>({
    hasOpenaiApiKey: false,
    defaultModel: defaultRuntimeModel,
    aiProviders: [],
    defaultAiProviderId: undefined,
    defaultOutputFolder: "",
    preferredValidationProfile: "local-valid",
    preferredContextMode: "triggered",
    theme: "light",
    includePolicies: true,
    includeTemplates: true,
    includeWorkflows: true,
    includeReferences: false,
    lastUpdateCheckAt: undefined,
    settingsPath: "",
    accountConnection: disconnectedAccountConnection(),
  });
  const [runtimeAppVersion, setRuntimeAppVersion] = useState(appVersion);
  const [updateState, setUpdateState] = useState<AppUpdateState>({
    status: "idle",
    update: null,
  });
  const [pendingMarketImportRequest, setPendingMarketImportRequest] = useState<MarketImportRequest | null>(null);
  const [marketDeepLinkError, setMarketDeepLinkError] = useState<string | null>(null);
  const [appState, setAppState] = useState<AppState>({
    currentKitPath: "",
    currentKitName: "",
    defaultOutputFolder: "",
    openAiApiKey: "",
    preferredValidationProfile: "local-valid",
  });

  const activeTitle = useMemo(
    () => navItems.find((item) => item.id === activeSection)?.label ?? secondarySectionTitles[activeSection] ?? "AgentKitForge",
    [activeSection],
  );

  useEffect(() => {
    forge.getAppSettings()
      .then((loadedSettings) => {
        setSettings(loadedSettings);
        updateAppState("defaultOutputFolder", loadedSettings.defaultOutputFolder);
        updateAppState("preferredValidationProfile", loadedSettings.preferredValidationProfile);
        forge.restoreAgentKitProjectAccount()
          .then(setSettings)
          .catch(() => {
            // Secure account restore is optional and must never block local Forge use.
          });
      })
      .catch(() => {
        setSettings({
          hasOpenaiApiKey: false,
          defaultModel: defaultRuntimeModel,
          aiProviders: [],
          defaultAiProviderId: undefined,
          defaultOutputFolder: "",
          preferredValidationProfile: "local-valid",
          preferredContextMode: "triggered",
          theme: "light",
          includePolicies: true,
          includeTemplates: true,
          includeWorkflows: true,
          includeReferences: false,
          lastUpdateCheckAt: undefined,
          settingsPath: "",
          accountConnection: disconnectedAccountConnection(),
        });
      });
  }, []);

  useEffect(() => {
    function handleDeepLink(url: string) {
      const parsed = parseMarketImportDeepLink(url);
      setActiveSection("import");
      if (parsed.ok) {
        setMarketDeepLinkError(null);
        setPendingMarketImportRequest(parsed.request);
      } else {
        setPendingMarketImportRequest(null);
        setMarketDeepLinkError(parsed.error);
      }
    }

    let unlisten: (() => void) | undefined;
    forge
      .getInitialDeepLinks()
      .then((urls) => {
        urls?.forEach(handleDeepLink);
      })
      .catch(() => {
        // Deep links are optional and must not block local Forge startup.
      });
    forge
      .onDeepLink((urls) => {
        urls.forEach(handleDeepLink);
      })
      .then((listener) => {
        unlisten = listener;
      })
      .catch(() => {
        // Deep link listener setup is optional in dev and unsupported packaging contexts.
      });

    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    forge
      .getAppVersion()
      .then(setRuntimeAppVersion)
      .catch(() => setRuntimeAppVersion(appVersion));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme || "light";
  }, [settings.theme]);

  useEffect(() => {
    if (updateState.status !== "idle" || !settings.settingsPath) {
      return;
    }

    const lastCheckedTime = settings.lastUpdateCheckAt
      ? Date.parse(settings.lastUpdateCheckAt)
      : 0;
    if (lastCheckedTime && Date.now() - lastCheckedTime < updateCheckIntervalMs) {
      setUpdateState((current) => ({
        ...current,
        lastCheckedAt: settings.lastUpdateCheckAt,
      }));
      return;
    }

    const timer = window.setTimeout(() => {
      void checkForUpdates(false);
    }, 2500);

    return () => window.clearTimeout(timer);
  }, [settings.lastUpdateCheckAt, settings.settingsPath, updateState.status]);

  useEffect(() => {
    const trimmedPath = appState.currentKitPath.trim();
    if (!trimmedPath) {
      updateAppState("currentKitName", "");
      return;
    }

    let isCurrent = true;
    forge.getAgentKitMetadata(trimmedPath)
      .then((metadata) => {
        if (isCurrent) {
          updateAppState("currentKitName", metadata.name || metadata.id || "Selected kit");
        }
      })
      .catch(() => {
        if (isCurrent) {
          updateAppState("currentKitName", "Selected kit");
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [appState.currentKitPath]);

  function updateAppState<Key extends keyof AppState>(key: Key, value: AppState[Key]) {
    setAppState((current) => ({ ...current, [key]: value }));
  }

  async function persistUpdateCheckTimestamp(checkedAt: string) {
    try {
      const updatedSettings = await forge.saveUpdateCheckTimestamp(checkedAt);
      setSettings(updatedSettings);
    } catch {
      setUpdateState((current) => ({ ...current, lastCheckedAt: checkedAt }));
    }
  }

  async function checkForUpdates(manual: boolean) {
    setUpdateState((current) => ({
      ...current,
      status: "checking",
      error: undefined,
      message: manual ? "Checking for updates..." : "Checking for updates in the background...",
    }));

    const checkedAt = new Date().toISOString();

    try {
      const update = await forge.checkForUpdate();
      await persistUpdateCheckTimestamp(checkedAt);

      if (update) {
        setUpdateState({
          status: "available",
          update,
          lastCheckedAt: checkedAt,
          message: `AgentKitForge ${update.version} is available.`,
        });
        return;
      }

      setUpdateState({
        status: "up-to-date",
        update: null,
        lastCheckedAt: checkedAt,
        message: "AgentKitForge is up to date.",
      });
    } catch (caughtError) {
      await persistUpdateCheckTimestamp(checkedAt);
      setUpdateState({
        status: "failed",
        update: null,
        lastCheckedAt: checkedAt,
        error: errorToMessage(caughtError),
      });
    }
  }

  async function installAvailableUpdate() {
    const update = updateState.update;
    if (!update) {
      return;
    }

    setUpdateState((current) => ({
      ...current,
      status: "downloading",
      error: undefined,
      message: `Downloading AgentKitForge ${update.version}...`,
      downloadedBytes: 0,
      totalBytes: undefined,
    }));

    let downloadedBytes = 0;
    let totalBytes: number | undefined;

    try {
      await update.download((event) => {
        if (event.event === "Started") {
          downloadedBytes = 0;
          totalBytes = event.data.contentLength ?? undefined;
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
        }
        setUpdateState((current) => ({
          ...current,
          downloadedBytes,
          totalBytes,
        }));
      });

      setUpdateState((current) => ({
        ...current,
        status: "installing",
        message: "Installing update...",
      }));

      await update.install();
      await forge.relaunchApp();
    } catch (caughtError) {
      setUpdateState((current) => ({
        ...current,
        status: "failed",
        error: errorToMessage(caughtError),
      }));
    }
  }

  function dismissUpdate() {
    setUpdateState((current) => ({
      ...current,
      status: "idle",
      message: undefined,
      error: undefined,
    }));
  }

  async function addKitToLibrary(path: string, source: KitLibrarySource) {
    try {
      await forge.addKitToLibrary({ path, source });
    } catch {
      // Library add failures should not block create/render/package flows.
    }
  }

  const sidebarAccountConnection = settings.accountConnection || disconnectedAccountConnection();
  const sidebarAccountName =
    accountDisplayName(sidebarAccountConnection) ||
    (sidebarAccountConnection.accountConnectionStatus === "connected" ? "AgentKitProject account" : "Not signed in");
  const sidebarAccountSubtext = sidebarAccountConnection.accountConnectionStatus === "connected"
    ? "Connected"
    : sidebarAccountConnection.accountConnectionStatus === "connecting"
      ? "Connecting..."
      : sidebarAccountConnection.accountConnectionStatus === "error"
        ? "Connection failed"
        : "Connect account";
  const sidebarAccountInitials = accountInitials(sidebarAccountConnection);

  return (
    <AppShell
      brandAccent="#4f46e5"
      logo={<img alt="" className="brand-icon" src={agentKitForgeIcon} />}
      brand={
        <>
          AgentKit<span>Forge</span>
        </>
      }
      brandSubtitle="Desktop Forge"
      eyebrow="Agent Kit workspace"
      title={activeTitle}
      nav={navItems.map((item) => {
        const Icon = item.icon;
        return {
          label: item.label,
          icon: <Icon size={18} strokeWidth={2.1} />,
          active: activeSection === item.id,
          onClick: () => setActiveSection(item.id),
        };
      })}
      account={
        <button
          className={`ak-sidebar__account ${activeSection === "account" ? "ak-sidebar__account--active" : ""}`}
          data-testid="sidebar-account-block"
          onClick={() => setActiveSection("account")}
          type="button"
        >
          <span className="ak-sidebar__account-avatar" aria-hidden="true">
            {sidebarAccountInitials || <UserCircle size={20} />}
          </span>
          <span className="ak-sidebar__account-text">
            <span className="ak-sidebar__account-name">{sidebarAccountName}</span>
            <span className="ak-sidebar__account-status">{sidebarAccountSubtext}</span>
          </span>
        </button>
      }
      sidebarFooter={
        <>
          <div className="current-kit-panel">
            <div className="panel-label">Current Kit</div>
            <div className="kit-path">{appState.currentKitName || "No kit selected"}</div>
          </div>
          <div className="sidebar-help">
            <button onClick={() => openDocsLink("https://forge.agentkitproject.com/docs/")} type="button">
              Docs
            </button>
            <button onClick={() => openDocsLink("https://forge.agentkitproject.com/agent-kit-spec/")} type="button">
              Agent Kit Spec
            </button>
          </div>
        </>
      }
    >
      {
        <>
          <UpdateNotice
            appVersion={runtimeAppVersion}
            onCheck={() => checkForUpdates(true)}
            onDismiss={dismissUpdate}
            onInstall={installAvailableUpdate}
            updateState={updateState}
          />
          {activeSection === "my-kits" && (
            <MyKitsScreen
              accountConnected={
                (settings.accountConnection || disconnectedAccountConnection())
                  .accountConnectionStatus === "connected"
              }
              onImportFavorite={(favorite) => {
                const slug = favorite.slug?.trim();
                setPendingMarketImportRequest({
                  id: `favorite-${favorite.kitId}`,
                  marketBaseUrl: agentKitProjectUrls.market,
                  identifier: slug || favorite.kitId,
                  identifierKind: slug ? "kit" : "kitId",
                  source: "manual",
                  requiresConfirmation: false,
                });
                setActiveSection("import");
              }}
              onBuildWithAI={() => {
                window.localStorage.setItem("agentkitforge.lastBuildTab", "ai");
                setActiveSection("build");
              }}
              onGuidedBuilder={() => {
                window.localStorage.setItem("agentkitforge.lastBuildTab", "guided");
                setActiveSection("build");
              }}
              onImportKit={() => setActiveSection("import")}
              onInstallKit={(path) => {
                updateAppState("currentKitPath", path);
                setActiveSection("install-targets");
              }}
              onPackageKit={(path) => {
                updateAppState("currentKitPath", path);
                setActiveSection("package-export");
              }}
              onSubmitToMarket={(path) => {
                updateAppState("currentKitPath", path);
                setActiveSection("market-submit");
              }}
              onUseKit={(path) => {
                updateAppState("currentKitPath", path);
                forge.markLibraryKitUsed(path).catch(() => undefined);
                setActiveSection("use");
              }}
              onValidateKit={(path) => {
                updateAppState("currentKitPath", path);
                setActiveSection("validate");
              }}
            />
          )}
          {activeSection === "import" && (
            <ImportScreen
              deepLinkError={marketDeepLinkError}
              initialMarketImportRequest={pendingMarketImportRequest}
              onAccountReconnectRequired={(message) => {
                setSettings((current) => ({
                  ...current,
                  accountConnection: {
                    ...(current.accountConnection || disconnectedAccountConnection()),
                    accountConnectionStatus: "error",
                    connectionError: message,
                  },
                }));
              }}
              onKitImported={(rootPath) => {
                updateAppState("currentKitPath", rootPath);
              }}
              onOpenAccount={() => setActiveSection("account")}
              onOpenMyKits={() => setActiveSection("my-kits")}
              onPackageKit={(rootPath) => {
                updateAppState("currentKitPath", rootPath);
                setActiveSection("package-export");
              }}
              onUseKit={(rootPath) => {
                updateAppState("currentKitPath", rootPath);
                setActiveSection("use");
              }}
              onSettingsChange={setSettings}
              settings={settings}
            />
          )}
          {activeSection === "build" && (
            <BuildScreen
              onKitReady={(rootPath) => {
                updateAppState("currentKitPath", rootPath);
                addKitToLibrary(rootPath, "built");
              }}
              onPackageKit={(rootPath) => {
                updateAppState("currentKitPath", rootPath);
                setActiveSection("package-export");
              }}
              onUseKit={(rootPath) => {
                updateAppState("currentKitPath", rootPath);
                setActiveSection("use");
              }}
              settings={settings}
              onValidateCreatedKit={(rootPath, profile) => {
                updateAppState("currentKitPath", rootPath);
                updateAppState("preferredValidationProfile", profile);
                setActiveSection("validate");
              }}
            />
          )}
          {activeSection === "use" && (
            <UseScreen
              currentKitPath={appState.currentKitPath}
              onKitPathChange={(value) => updateAppState("currentKitPath", value)}
              settings={settings}
            />
          )}
          {activeSection === "run-chat" && (
            <RunChatScreen
              currentKitPath={appState.currentKitPath}
              onKitPathChange={(value) => updateAppState("currentKitPath", value)}
              onOpenAccount={() => setActiveSection("account")}
              settings={settings}
            />
          )}
          {activeSection === "validate" && (
            <ValidateScreen
              currentKitPath={appState.currentKitPath}
              profile={appState.preferredValidationProfile}
              onKitPathChange={(value) => updateAppState("currentKitPath", value)}
              onProfileChange={(value) => updateAppState("preferredValidationProfile", value)}
            />
          )}
          {activeSection === "package-export" && (
            <PackageExportScreen
              currentKitPath={appState.currentKitPath}
              onKitPathChange={(value) => updateAppState("currentKitPath", value)}
              onKitPackaged={(path) => addKitToLibrary(path, "manual")}
              settings={settings}
            />
          )}
          {activeSection === "market-submit" && (
            <MarketSubmitScreen
              currentKitPath={appState.currentKitPath}
              onAccountReconnectRequired={(message) => {
                setSettings((current) => ({
                  ...current,
                  accountConnection: {
                    ...(current.accountConnection || disconnectedAccountConnection()),
                    accountConnectionStatus: "error",
                    connectionError: message,
                  },
                }));
              }}
              onKitPathChange={(value) => updateAppState("currentKitPath", value)}
              onOpenAccount={() => setActiveSection("account")}
              onOpenMyKits={() => setActiveSection("my-kits")}
              onSettingsChange={setSettings}
              settings={settings}
            />
          )}
          {activeSection === "install-targets" && (
            <InstallTargetsScreen
              currentKitPath={appState.currentKitPath}
              onKitPathChange={(value) => updateAppState("currentKitPath", value)}
            />
          )}
          {activeSection === "settings" && (
            <SettingsScreen
              appState={appState}
              appVersion={runtimeAppVersion}
              onOpenAccount={() => setActiveSection("account")}
              onSettingsChange={setSettings}
              onUpdate={updateAppState}
              onCheckForUpdates={() => checkForUpdates(true)}
              onInstallUpdate={installAvailableUpdate}
              settings={settings}
              updateState={updateState}
            />
          )}
          {activeSection === "account" && (
            <AccountScreen
              onSettingsChange={setSettings}
              settings={settings}
            />
          )}
          {activeSection === "about" && <AboutScreen appVersion={runtimeAppVersion} settings={settings} />}
        </>
      }
    </AppShell>
  );
}

function UpdateNotice({
  appVersion,
  onCheck,
  onDismiss,
  onInstall,
  updateState,
}: {
  appVersion: string;
  onCheck: () => void;
  onDismiss: () => void;
  onInstall: () => void;
  updateState: AppUpdateState;
}) {
  const isBusy = updateState.status === "checking" || updateState.status === "downloading" || updateState.status === "installing";
  const isVisible =
    updateState.status === "available" ||
    updateState.status === "downloading" ||
    updateState.status === "installing" ||
    updateState.status === "failed";

  if (!isVisible) {
    return null;
  }

  const progress =
    updateState.status === "downloading" && updateState.downloadedBytes
      ? updateState.totalBytes
        ? `${formatByteCount(updateState.downloadedBytes)} of ${formatByteCount(updateState.totalBytes)}`
        : formatByteCount(updateState.downloadedBytes)
      : null;

  return (
    <div className={`update-banner ${updateState.status === "failed" ? "failed" : ""}`} role="status">
      <div>
        <strong>
          {updateState.status === "available"
            ? `AgentKitForge ${updateState.update?.version} is available`
            : updateState.status === "failed"
              ? "Update check failed"
              : updateState.message || "Updating AgentKitForge"}
        </strong>
        <p>
          {updateState.status === "available"
            ? `You are running ${appVersion}. Install when you are ready.`
            : updateState.status === "failed"
              ? updateState.error || "AgentKitForge could not check for updates."
              : progress || updateState.message}
        </p>
        {updateState.update?.body && updateState.status === "available" && (
          <details className="advanced-details compact-details">
            <summary>Release notes</summary>
            <div className="markdown-preview">{updateState.update.body}</div>
          </details>
        )}
      </div>
      <div className="button-row update-actions">
        {updateState.status === "available" && (
          <button className="primary-button" onClick={onInstall} type="button">
            Update now
          </button>
        )}
        {updateState.status === "failed" && (
          <button className="secondary-button" disabled={isBusy} onClick={onCheck} type="button">
            Try again
          </button>
        )}
        {isBusy && <LoadingStatus text={updateState.message || "Updating..."} />}
        {!isBusy && (
          <button className="secondary-button" onClick={onDismiss} type="button">
            Later
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Cloud Favorites — synced. ADDITIVE, opt-in layer over the local My Kits
 * library: rendered ONLY when the AgentKitProject account is connected. When
 * signed out this component renders nothing, so local-first behavior (local
 * kits, offline, no-login) is unaffected. Failures degrade quietly to an inline
 * note; they never block the surrounding local My Kits view.
 */
function CloudFavoritesSection({
  accountConnected,
  onImportFavorite,
}: {
  accountConnected: boolean;
  onImportFavorite: (favorite: CloudFavorite) => void;
}) {
  const [favorites, setFavorites] = useState<CloudFavorite[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyKitId, setBusyKitId] = useState<string | null>(null);

  useEffect(() => {
    if (!accountConnected) {
      setFavorites([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    forge
      .listCloudFavorites()
      .then((result) => {
        if (!cancelled) {
          setFavorites(result.items);
        }
      })
      .catch((caughtError) => {
        if (!cancelled) {
          setError(errorToMessage(caughtError));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accountConnected]);

  // Opt-in: nothing renders unless the account is connected.
  if (!accountConnected) {
    return null;
  }

  async function removeFavorite(kitId: string) {
    setBusyKitId(kitId);
    setError(null);
    try {
      await forge.removeCloudFavorite(kitId);
      setFavorites((current) => current.filter((favorite) => favorite.kitId !== kitId));
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    } finally {
      setBusyKitId(null);
    }
  }

  return (
    <section className="cloud-favorites">
      <div className="cloud-favorites-header">
        <h2>
          <Star size={18} /> Favorites — synced
        </h2>
        <span className="source-badge">AgentKitProject</span>
      </div>
      {error && (
        <div className="inline-warning" role="status">
          Couldn&apos;t sync favorites: {error}
        </div>
      )}
      {isLoading ? (
        <LoadingStatus text="Loading your synced favorites..." />
      ) : favorites.length === 0 ? (
        <p className="form-copy">
          No synced favorites yet. Star a kit while browsing AgentKitMarket and it will appear here on every signed-in device.
        </p>
      ) : (
        <div className="kit-list">
          {favorites.map((favorite) => (
            <article className="kit-library-card" key={favorite.kitId}>
              <div className="kit-library-main">
                <div>
                  <h2>{favorite.displayName || favorite.slug}</h2>
                  <p>{favorite.summary || "Synced from AgentKitMarket."}</p>
                </div>
                <span className="source-badge">market</span>
              </div>
              {favorite.publisherName && (
                <dl className="kit-meta-grid">
                  <div>
                    <dt>Publisher</dt>
                    <dd>{favorite.publisherName}</dd>
                  </div>
                </dl>
              )}
              <div className="button-row">
                <button
                  className="secondary-button compact-button"
                  onClick={() => onImportFavorite(favorite)}
                  type="button"
                >
                  Import
                </button>
                <button
                  className="secondary-button compact-button"
                  disabled={busyKitId === favorite.kitId}
                  onClick={() => void removeFavorite(favorite.kitId)}
                  type="button"
                >
                  <StarOff size={16} />
                  {busyKitId === favorite.kitId ? "Removing..." : "Unfavorite"}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function MyKitsScreen({
  accountConnected,
  onBuildWithAI,
  onGuidedBuilder,
  onImportFavorite,
  onImportKit,
  onInstallKit,
  onPackageKit,
  onSubmitToMarket,
  onUseKit,
  onValidateKit,
}: {
  accountConnected: boolean;
  onBuildWithAI: () => void;
  onGuidedBuilder: () => void;
  onImportFavorite: (favorite: CloudFavorite) => void;
  onImportKit: () => void;
  onInstallKit: (path: string) => void;
  onPackageKit: (path: string) => void;
  onSubmitToMarket: (path: string) => void;
  onUseKit: (path: string) => void;
  onValidateKit: (path: string) => void;
}) {
  const [kits, setKits] = useState<MyKitEntry[]>([]);
  const [kitSummaries, setKitSummaries] = useState<Record<string, AgentKitSummary>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingRemovalPath, setPendingRemovalPath] = useState<string | null>(null);
  const [removingPath, setRemovingPath] = useState<string | null>(null);
  const [versionBusyPath, setVersionBusyPath] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<Record<string, string>>({});
  const [updateCheckBusyPath, setUpdateCheckBusyPath] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<Record<string, { text: string; tone: "info" | "available" | "warning" }>>({});

  useEffect(() => {
    loadKits();
  }, []);

  function clearVersionError(path: string) {
    setVersionError((current) => {
      if (!(path in current)) {
        return current;
      }
      const next = { ...current };
      delete next[path];
      return next;
    });
  }

  async function applyVersionChange(
    path: string,
    action: () => Promise<{ previous: string; next: string }>,
  ) {
    setVersionBusyPath(path);
    clearVersionError(path);
    setMessage(null);
    try {
      const result = await action();
      await loadKits();
      setMessage(`Updated to ${formatDisplayVersion(result.next)}.`);
    } catch (caughtError) {
      setVersionError((current) => ({ ...current, [path]: errorToMessage(caughtError) }));
    } finally {
      setVersionBusyPath(null);
    }
  }

  function nextKitVersion(path: string) {
    void applyVersionChange(path, () =>
      forge.nextAgentKitVersion(path),
    );
  }

  async function checkKitForUpdate(kit: MyKitEntry) {
    if (!kit.sourceMarketSlug || !kit.marketBaseUrl) {
      return;
    }
    setUpdateCheckBusyPath(kit.path);
    setUpdateStatus((current) => {
      const next = { ...current };
      delete next[kit.path];
      return next;
    });
    try {
      const status = await forge.checkKitUpdate({
        marketBaseUrl: kit.marketBaseUrl,
        slug: kit.sourceMarketSlug,
        installedVersion: kit.version,
      });
      // NO automatic updates — only report availability.
      let result: { text: string; tone: "info" | "available" | "warning" };
      if (status.reason === "not_found") {
        result = { text: "No longer available in AgentKitMarket", tone: "warning" };
      } else if (status.reason === "error") {
        result = { text: "Couldn't check for updates", tone: "warning" };
      } else if (status.updateAvailable && status.latestVersion) {
        result = { text: `Update available — ${formatDisplayVersion(status.latestVersion)}`, tone: "available" };
      } else {
        result = { text: "Up to date", tone: "info" };
      }
      setUpdateStatus((current) => ({ ...current, [kit.path]: result }));
    } catch {
      setUpdateStatus((current) => ({
        ...current,
        [kit.path]: { text: "Couldn't check for updates", tone: "warning" },
      }));
    } finally {
      setUpdateCheckBusyPath(null);
    }
  }

  async function loadKits() {
    setIsLoading(true);
    setError(null);

    try {
      const loadedKits = await forge.listMyKits();
      setKits(loadedKits);
      void loadKitSummaries(loadedKits);
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    } finally {
      setIsLoading(false);
    }
  }

  async function loadKitSummaries(loadedKits: MyKitEntry[]) {
    const entries = await Promise.all(
      loadedKits
        .filter((kit) => kit.pathExists)
        .map(async (kit) => {
          try {
            const summary = await forge.getAgentKitSummary(kit.path);
            return [kit.path, summary] as const;
          } catch {
            return null;
          }
        }),
    );
    setKitSummaries(Object.fromEntries(entries.filter((entry): entry is readonly [string, AgentKitSummary] => Boolean(entry))));
  }

  function requestRemoveKit(path: string) {
    setError(null);
    setMessage(null);
    setPendingRemovalPath(path);
  }

  async function confirmRemoveKit(path: string) {
    setError(null);
    setMessage(null);
    setRemovingPath(path);
    try {
      const result = await forge.removeKitFromLibrary(path);
      setPendingRemovalPath(null);
      await loadKits();
      if (result.deletedLocalFiles) {
        setMessage("Kit removed from My Kits and deleted locally.");
      } else if (result.removedFromLibrary) {
        setMessage("Kit removed from My Kits. External files were left in place.");
      } else {
        setMessage("Kit was not found in My Kits.");
      }
    } catch (caughtError) {
      setError(`Kit removal failed: ${errorToMessage(caughtError)}`);
    } finally {
      setRemovingPath(null);
    }
  }

  async function refreshKit(path: string) {
    setError(null);
    try {
      await forge.refreshKitMetadata(path);
      await loadKits();
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    }
  }

  async function validateKit(path: string) {
    setError(null);
    try {
      await forge.validateLibraryKit(path);
      await loadKits();
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    }
  }

  async function openKitFolder(path: string) {
    setError(null);
    try {
      await forge.openFolder(path);
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    }
  }

  if (isLoading) {
    return (
      <div className="empty-state">
        <PackageOpen size={42} strokeWidth={1.8} />
        <h2>Loading kits</h2>
        <LoadingStatus text="Reading My Kits library..." />
      </div>
    );
  }

  if (kits.length === 0) {
    return (
      <div className="my-kits-screen">
        <div className="empty-state">
          <PackageOpen size={42} strokeWidth={1.8} />
          <h2>No Agent Kits yet.</h2>
          <p>Build, import, or add an existing kit to start your local library.</p>
          {error && (
            <div className="error-state" role="alert">
              {error}
            </div>
          )}
          <div className="button-row">
            <button className="primary-button" onClick={onBuildWithAI} type="button">Build with AI</button>
            <button className="secondary-button" onClick={onGuidedBuilder} type="button">Guided Builder</button>
            <button className="secondary-button" onClick={onImportKit} type="button">Import Agent Kit</button>
            <button className="secondary-button" onClick={() => openDocsLink(agentKitProjectUrls.marketKits)} type="button">Browse AgentKitMarket</button>
          </div>
          <div className="help-link-row">
            <button onClick={() => openDocsLink("https://forge.agentkitproject.com/docs/")} type="button">Read the docs</button>
            <button onClick={() => openDocsLink("https://forge.agentkitproject.com/agent-kit-spec/")} type="button">Agent Kit Spec</button>
          </div>
        </div>
        <CloudFavoritesSection accountConnected={accountConnected} onImportFavorite={onImportFavorite} />
      </div>
    );
  }

  return (
    <div className="my-kits-screen">
      {error && (
        <div className="error-state" role="alert">
          {error}
        </div>
      )}
      {message && <div className="copy-state">{message}</div>}

      <div className="button-row">
        <button className="secondary-button" onClick={onImportKit} type="button">
          <FileArchive size={18} />
          Import .agentkit.zip
        </button>
        <button className="secondary-button" onClick={() => openDocsLink(agentKitProjectUrls.marketKits)} type="button">
          Browse AgentKitMarket
        </button>
      </div>

      <CloudFavoritesSection accountConnected={accountConnected} onImportFavorite={onImportFavorite} />

      <div className="kit-list">
        {kits.map((kit) => (
          <article className={`kit-library-card ${kit.pathExists ? "" : "missing"}`} key={kit.path}>
            <div className="kit-library-main">
              <div>
                <h2>{kit.name}</h2>
                <p>{kit.description || "No description available."}</p>
              </div>
              <span className="source-badge">{kit.source}</span>
            </div>

            {!kit.pathExists && (
              <div className="inline-warning">This folder no longer exists on disk.</div>
            )}

            <dl className="kit-meta-grid">
              <div>
                <dt>Version</dt>
                <dd>{formatDisplayVersion(kit.version)}</dd>
              </div>
              <div>
                <dt>Location</dt>
                <dd>{friendlyLocation(kit.path)}</dd>
              </div>
              <div>
                <dt>Validation</dt>
                <dd>{formatValidationState(kit)}</dd>
              </div>
              <div>
                <dt>Last used</dt>
                <dd>{formatTimestamp(kit.lastUsedAt)}</dd>
              </div>
            </dl>
            {kit.pathExists && (
              <div className="kit-version-editor">
                <label>Version</label>
                <div className="button-row">
                  <span className="kit-version-current">{formatDisplayVersion(kit.version)}</span>
                  <button
                    className="primary-button compact-button"
                    disabled={versionBusyPath === kit.path}
                    onClick={() => nextKitVersion(kit.path)}
                    type="button"
                  >
                    New version
                  </button>
                </div>
                {versionError[kit.path] && (
                  <div className="inline-warning" role="alert">{versionError[kit.path]}</div>
                )}
              </div>
            )}

            <details className="advanced-details">
              <summary>Details</summary>
              <MyKitDetails kit={kit} summary={kitSummaries[kit.path]} />
            </details>

            <div className="button-row">
              <button className="secondary-button compact-button" disabled={!kit.pathExists} onClick={() => onUseKit(kit.path)} type="button">
                Use Kit
              </button>
              <button className="secondary-button compact-button" disabled={!kit.pathExists} onClick={() => onValidateKit(kit.path)} type="button">
                Validate
              </button>
              <button className="secondary-button compact-button" disabled={!kit.pathExists} onClick={() => onPackageKit(kit.path)} type="button">
                Package / Export
              </button>
              <button className="secondary-button compact-button" disabled={!kit.pathExists} onClick={() => onSubmitToMarket(kit.path)} type="button">
                Submit to Market
              </button>
              <button className="secondary-button compact-button" disabled={!kit.pathExists} onClick={() => onInstallKit(kit.path)} type="button">
                Install Target
              </button>
              <button className="secondary-button compact-button" disabled={!kit.pathExists} onClick={() => openKitFolder(kit.path)} type="button">
                Open folder
              </button>
              <button className="secondary-button compact-button" disabled={!kit.pathExists} onClick={() => refreshKit(kit.path)} type="button">
                Refresh
              </button>
              {kit.source === "market" && kit.sourceMarketSlug && kit.marketBaseUrl && (
                <button
                  className="secondary-button compact-button"
                  disabled={updateCheckBusyPath === kit.path}
                  onClick={() => checkKitForUpdate(kit)}
                  type="button"
                >
                  {updateCheckBusyPath === kit.path ? "Checking..." : "Check for updates"}
                </button>
              )}
              <button className="secondary-button compact-button" onClick={() => requestRemoveKit(kit.path)} type="button">
                Remove from My Kits
              </button>
            </div>
            {updateStatus[kit.path] && (
              <div
                className={updateStatus[kit.path].tone === "warning" ? "inline-warning" : "copy-state"}
                role="status"
              >
                {updateStatus[kit.path].text}
              </div>
            )}
            {pendingRemovalPath === kit.path && (
              <div className="inline-warning" role="status">
                Remove this kit from My Kits? Kits stored in Forge's local library folder will be deleted from disk.
                <div className="button-row">
                  <button
                    className="primary-button compact-button"
                    disabled={removingPath === kit.path}
                    onClick={() => confirmRemoveKit(kit.path)}
                    type="button"
                  >
                    {removingPath === kit.path ? "Removing..." : "Confirm remove"}
                  </button>
                  <button
                    className="secondary-button compact-button"
                    disabled={removingPath === kit.path}
                    onClick={() => setPendingRemovalPath(null)}
                    type="button"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            <p className="form-copy compact-state">
              Removes the kit from My Kits. Kits stored in Forge's local library folder are deleted from disk; external folders are only removed from this list.
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}

function MyKitDetails({ kit, summary }: { kit: MyKitEntry; summary?: AgentKitSummary }) {
  const lists = summary?.lists ?? {};
  const skills = summaryList(lists.skills);
  const prompts = summaryList(lists.preparedPrompts ?? lists.prompts);
  const policies = summaryList(lists.policies);
  const templates = summaryList(lists.templates);
  const examples = summaryList(lists.examples);
  const workflows = summaryList(lists.workflows);
  const references = summaryList(lists.references);

  return (
    <div className="kit-details-panel">
      <section>
        <h3>Overview</h3>
        <dl className="report-meta">
          <div><dt>Name</dt><dd>{summary?.name || kit.name}</dd></div>
          <div><dt>Version</dt><dd>{formatDisplayVersion(summary?.version || kit.version)}</dd></div>
          <div><dt>Description</dt><dd>{summary?.description || kit.description || "No description available."}</dd></div>
          <div><dt>Domain</dt><dd>{summary?.domain || "Not specified"}</dd></div>
          <div><dt>Source</dt><dd>{kit.sourceLabel || kit.source}</dd></div>
          {kit.packageFileName && <div><dt>Package</dt><dd>{kit.packageFileName}</dd></div>}
          {kit.schemaVersion && <div><dt>Schema</dt><dd>{kit.schemaVersion}</dd></div>}
          {kit.sha256 && <div><dt>SHA-256</dt><dd>{kit.sha256.slice(0, 16)}...</dd></div>}
          {kit.sourceMarketSlug && <div><dt>Market slug</dt><dd>{kit.sourceMarketSlug}</dd></div>}
          {kit.installedAt && <div><dt>Installed</dt><dd>{formatTimestamp(kit.installedAt)}</dd></div>}
          <div><dt>Validation</dt><dd>{formatValidationState(kit)}</dd></div>
        </dl>
      </section>

      <section>
        <h3>Components</h3>
        <dl className="report-meta">
          <div><dt>Skills</dt><dd>{summaryCount(summary, "skills", skills.length)}</dd></div>
          <div><dt>Prepared Prompts</dt><dd>{summaryCount(summary, "preparedPrompts", prompts.length)}</dd></div>
          <div><dt>Policies</dt><dd>{summaryCount(summary, "policies", policies.length)}</dd></div>
          <div><dt>Templates</dt><dd>{summaryCount(summary, "templates", templates.length)}</dd></div>
          <div><dt>Examples</dt><dd>{summaryCount(summary, "examples", examples.length)}</dd></div>
          <div><dt>Workflows</dt><dd>{summaryCount(summary, "workflows", workflows.length)}</dd></div>
          <div><dt>References</dt><dd>{summaryCount(summary, "references", references.length)}</dd></div>
        </dl>
      </section>

      <SummaryListSection title="Prepared Prompts" items={prompts} kind="prompt" />
      <SummaryListSection title="Skills" items={skills} kind="skill" />
      <SummaryListSection title="Policies" items={policies} />
      <SummaryListSection title="Templates" items={templates} />
      <SummaryListSection title="Examples" items={examples} />
      {(workflows.length > 0 || references.length > 0) && (
        <SummaryListSection title="Workflows / References" items={[...workflows, ...references]} />
      )}

      <section>
        <h3>Location</h3>
        <dl className="report-meta">
          <div><dt>Location</dt><dd>{friendlyLocation(kit.path)}</dd></div>
        </dl>
        <details className="advanced-details compact-advanced">
          <summary>Show full path</summary>
          <div className="inline-code">{kit.path}</div>
        </details>
      </section>

      <details className="advanced-details compact-advanced">
        <summary>Technical details</summary>
        <dl className="report-meta">
          <div><dt>Raw path</dt><dd>{kit.path}</dd></div>
          <div><dt>Manifest path</dt><dd>{summary?.paths?.manifestPath || "Not loaded"}</dd></div>
        </dl>
        {summary && <pre className="json-panel">{JSON.stringify(summary, null, 2)}</pre>}
      </details>
    </div>
  );
}

function SummaryListSection({
  items,
  kind,
  title,
}: {
  items: Record<string, unknown>[];
  kind?: "prompt" | "skill";
  title: string;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <section>
      <h3>{title}</h3>
      <div className="kit-detail-list">
        {items.map((item, index) => (
          <article key={`${title}-${index}`}>
            <strong>{summaryItemName(item, title)}</strong>
            <p>{stringValue(item.description, "No description available.")}</p>
            {kind === "prompt" && (
              <small>
                {summaryPromptInputCount(item)} input{summaryPromptInputCount(item) === 1 ? "" : "s"}
                {item.documentLikeOutput === true ? " - document-like output" : ""}
              </small>
            )}
            {kind === "skill" && <small>Risk: {stringValue(item.riskLevel, "not specified")}</small>}
          </article>
        ))}
      </div>
    </section>
  );
}

function ImportScreen({
  deepLinkError,
  initialMarketImportRequest,
  onAccountReconnectRequired,
  onKitImported,
  onOpenAccount,
  onOpenMyKits,
  onPackageKit,
  onSettingsChange,
  onUseKit,
  settings,
}: {
  deepLinkError: string | null;
  initialMarketImportRequest: MarketImportRequest | null;
  onAccountReconnectRequired: (message: string) => void;
  onKitImported: (path: string) => void;
  onOpenAccount: () => void;
  onOpenMyKits: () => void;
  onPackageKit: (path: string) => void;
  onSettingsChange: (settings: PublicSettings) => void;
  onUseKit: (path: string) => void;
  settings: PublicSettings;
}) {
  const [form, setForm] = useState({
    packagePath: "",
    destinationRootFolder: appKitsFolder(settings),
    force: false,
    importAsCopy: false,
    validationProfile: settings.preferredValidationProfile,
  });
  const [activeTab, setActiveTab] = useState<ImportTabId>("zip");
  const [result, setResult] = useState<ImportAgentKitPackageResult | null>(null);
  const [packagePreview, setPackagePreview] = useState<AgentKitPackagePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isSelectingPackage, setIsSelectingPackage] = useState(false);
  const [isSelectingDestination, setIsSelectingDestination] = useState(false);
  const [isPreviewingPackage, setIsPreviewingPackage] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  const [folderInspection, setFolderInspection] = useState<AgentKitCandidateInspection | null>(null);
  const [folderValidation, setFolderValidation] = useState<ValidationReport | null>(null);
  const [folderImportError, setFolderImportError] = useState<string | null>(null);
  const [isInspectingFolder, setIsInspectingFolder] = useState(false);
  const [gitForm, setGitForm] = useState({
    repositoryUrl: "",
    reference: "",
    destinationRootFolder: appKitsFolder(settings),
    validationProfile: settings.preferredValidationProfile,
  });
  const [gitResult, setGitResult] = useState<ImportAgentKitFromGitResult | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  const [gitTechnicalError, setGitTechnicalError] = useState<string | null>(null);
  const [isImportingGit, setIsImportingGit] = useState(false);
  const [isSelectingGitDestination, setIsSelectingGitDestination] = useState(false);

  useEffect(() => {
    if (initialMarketImportRequest || deepLinkError) {
      setActiveTab("market");
    }
  }, [deepLinkError, initialMarketImportRequest]);

  function updateForm<Key extends keyof typeof form>(key: Key, value: (typeof form)[Key]) {
    setForm((current) => ({ ...current, [key]: value }));
    setResult(null);
    setError(null);
    if (key === "packagePath") {
      setPackagePreview(null);
      setPreviewError(null);
    }
  }

  async function inspectPackage(packagePath = form.packagePath) {
    setIsPreviewingPackage(true);
    setPreviewError(null);
    setPackagePreview(null);
    try {
      if (!packagePath.trim()) {
        throw new Error("Choose a package first.");
      }
      const preview = await forge.inspectAgentKitPackage(packagePath);
      setPackagePreview(preview);
      if (preview.duplicateWarnings.length > 0) {
        setForm((current) => ({ ...current, importAsCopy: false }));
      }
    } catch (caughtError) {
      setPreviewError(errorToMessage(caughtError));
    } finally {
      setIsPreviewingPackage(false);
    }
  }

  async function selectPackageFile() {
    setIsSelectingPackage(true);
    setError(null);
    try {
      const selectedPath = await forge.selectAgentKitPackageFile();
      if (selectedPath) {
        updateForm("packagePath", selectedPath);
        await inspectPackage(selectedPath);
      }
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    } finally {
      setIsSelectingPackage(false);
    }
  }

  async function selectDestinationFolder() {
    setIsSelectingDestination(true);
    setError(null);
    try {
      const selectedPath = await forge.selectAgentKitFolder();
      if (selectedPath) {
        updateForm("destinationRootFolder", selectedPath);
      }
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    } finally {
      setIsSelectingDestination(false);
    }
  }

  async function importPackage() {
    setIsImporting(true);
    setError(null);
    setResult(null);
    try {
      if (!form.packagePath.trim()) {
        throw new Error("Choose a package first.");
      }
      if (!form.destinationRootFolder.trim()) {
        throw new Error("Choose an import destination.");
      }
      if (packagePreview?.duplicateWarnings.length && !form.importAsCopy && !form.force) {
        throw new Error("This kit already appears in My Kits. Choose Import as copy to keep both copies, or cancel.");
      }
      const importResult = await forge.importAgentKitPackage(form);
      setResult(importResult);
      onKitImported(importResult.extractedPath);

      if (importResult.validationReport.valid) {
        await forge.addKitToLibrary({
            path: importResult.extractedPath,
            source: "local_import",
            packageMetadata: importResult.packageMetadata,
          });
      }
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    } finally {
      setIsImporting(false);
    }
  }

  async function addInvalidImportAnyway() {
    if (!result) {
      return;
    }
    try {
      await forge.addKitToLibrary({ path: result.extractedPath, source: "local_import", packageMetadata: result.packageMetadata });
      onKitImported(result.extractedPath);
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    }
  }

  async function selectFolderForImport() {
    setIsInspectingFolder(true);
    setFolderImportError(null);
    setFolderInspection(null);
    setFolderValidation(null);
    try {
      const selectedPath = await forge.selectAgentKitFolder();
      if (selectedPath) {
        setFolderPath(selectedPath);
        const inspection = await forge.inspectAgentKitCandidate(selectedPath);
        setFolderInspection(inspection);

        if (inspection.looksLikeAgentKit) {
          const report = await forge.validateAgentKit({ path: selectedPath, profile: form.validationProfile });
          setFolderValidation(report);
          if (report.valid) {
            await forge.addKitToLibrary({ path: selectedPath, source: "manual" });
            onKitImported(selectedPath);
          }
        }
      }
    } catch (caughtError) {
      setFolderImportError(errorToMessage(caughtError));
    } finally {
      setIsInspectingFolder(false);
    }
  }

  async function addFolderAnyway() {
    if (!folderPath) {
      return;
    }
    setFolderImportError(null);
    try {
      await forge.addKitToLibrary({ path: folderPath, source: "manual" });
      onKitImported(folderPath);
    } catch (caughtError) {
      setFolderImportError(errorToMessage(caughtError));
    }
  }

  function updateGitForm<Key extends keyof typeof gitForm>(key: Key, value: (typeof gitForm)[Key]) {
    setGitForm((current) => ({ ...current, [key]: value }));
    setGitResult(null);
    setGitError(null);
    setGitTechnicalError(null);
  }

  async function selectGitDestinationFolder() {
    setIsSelectingGitDestination(true);
    setGitError(null);
    setGitTechnicalError(null);
    try {
      const selectedPath = await forge.selectAgentKitFolder();
      if (selectedPath) {
        updateGitForm("destinationRootFolder", selectedPath);
      }
    } catch (caughtError) {
      setGitError(errorToMessage(caughtError));
    } finally {
      setIsSelectingGitDestination(false);
    }
  }

  async function importGitRepository() {
    setIsImportingGit(true);
    setGitError(null);
    setGitTechnicalError(null);
    setGitResult(null);
    try {
      if (!gitForm.repositoryUrl.trim()) {
        throw new Error("Enter a Git repository URL.");
      }
      if (!gitForm.destinationRootFolder.trim()) {
        throw new Error("Choose an import destination.");
      }
      const importResult = await forge.importAgentKitFromGit({
          repositoryUrl: gitForm.repositoryUrl,
          reference: gitForm.reference,
          destinationRootFolder: gitForm.destinationRootFolder,
          validationProfile: gitForm.validationProfile,
        });
      setGitResult(importResult);
      if (importResult.importedPath && importResult.validationReport?.valid) {
        await forge.addKitToLibrary({ path: importResult.importedPath, source: "imported" });
        onKitImported(importResult.importedPath);
      }
    } catch (caughtError) {
      const message = errorToMessage(caughtError);
      if (message.toLowerCase().includes("could not clone") || message.toLowerCase().includes("could not start git")) {
        setGitError("AgentKitForge could not clone this repository.");
        setGitTechnicalError(message);
      } else {
        setGitError(message);
      }
    } finally {
      setIsImportingGit(false);
    }
  }

  async function openImportedFolder() {
    if (!result) {
      return;
    }
    try {
      await forge.openFolder(result.extractedPath);
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    }
  }

  return (
    <div className="import-screen">
      <div className="tab-list" role="tablist" aria-label="Import options">
        {[
          ["zip", "From .agentkit.zip"],
          ["folder", "From Folder"],
          ["git", "From Git Repository"],
          ["market", "From Agent Kit Market"],
          ["org", "From Organization Repository"],
        ].map(([tabId, label]) => (
          <button
            aria-selected={activeTab === tabId}
            className={`tab-button ${activeTab === tabId ? "active" : ""}`}
            key={tabId}
            onClick={() => setActiveTab(tabId as ImportTabId)}
            role="tab"
            type="button"
          >
            {label}{tabId === "org" ? " - Coming later" : ""}
          </button>
        ))}
      </div>

      <div className="build-layout">
        {activeTab === "zip" && (
          <ImportPackagePanel
            form={form}
            importError={error}
            importResult={result}
            isPreviewingPackage={isPreviewingPackage}
            isImporting={isImporting}
            isSelectingDestination={isSelectingDestination}
            isSelectingPackage={isSelectingPackage}
            onAddInvalidImportAnyway={addInvalidImportAnyway}
            onImportPackage={importPackage}
            onOpenImportedFolder={openImportedFolder}
            onPackageKit={onPackageKit}
            onPreviewPackage={() => inspectPackage()}
            onSelectDestinationFolder={selectDestinationFolder}
            onSelectPackageFile={selectPackageFile}
            onUpdateForm={updateForm}
            onUseKit={onUseKit}
            packagePreview={packagePreview}
            previewError={previewError}
          />
        )}
        {activeTab === "folder" && (
          <ImportFolderPanel
            error={folderImportError}
            folderPath={folderPath}
            inspection={folderInspection}
            isLoading={isInspectingFolder}
            onAddAnyway={addFolderAnyway}
            onOpenFolder={() => folderPath && forge.openFolder(folderPath)}
            onPackageKit={onPackageKit}
            onSelectFolder={selectFolderForImport}
            onUseKit={onUseKit}
            validationReport={folderValidation}
          />
        )}
        {activeTab === "git" && (
          <ImportGitPanel
            error={gitError}
            form={gitForm}
            isImporting={isImportingGit}
            isSelectingDestination={isSelectingGitDestination}
            onImport={importGitRepository}
            onOpenFolder={(path) => forge.openFolder(path)}
            onPackageKit={onPackageKit}
            onSelectDestination={selectGitDestinationFolder}
            onUpdateForm={updateGitForm}
            onUseKit={onUseKit}
            result={gitResult}
            technicalError={gitTechnicalError}
          />
        )}
        {activeTab === "market" && (
          <MarketImportPanel
            accountConnection={settings.accountConnection || disconnectedAccountConnection()}
            deepLinkError={deepLinkError}
            initialRequest={initialMarketImportRequest}
            onAccountReconnectRequired={onAccountReconnectRequired}
            onKitImported={onKitImported}
            onOpenAccount={onOpenAccount}
            onOpenZipImport={() => setActiveTab("zip")}
            onOpenMyKits={onOpenMyKits}
            onSettingsChange={onSettingsChange}
            onUseKit={onUseKit}
          />
        )}
        {activeTab === "org" && <ComingSoonImportPanel title="Organization Repository" />}
      </div>
    </div>
  );
}

function ImportPackagePanel({
  form,
  importError,
  importResult,
  isPreviewingPackage,
  isImporting,
  isSelectingDestination,
  isSelectingPackage,
  onAddInvalidImportAnyway,
  onImportPackage,
  onOpenImportedFolder,
  onPackageKit,
  onPreviewPackage,
  onSelectDestinationFolder,
  onSelectPackageFile,
  onUpdateForm,
  onUseKit,
  packagePreview,
  previewError,
}: {
  form: {
    packagePath: string;
    destinationRootFolder: string;
    force: boolean;
    importAsCopy: boolean;
    validationProfile: ValidationProfile;
  };
  importError: string | null;
  importResult: ImportAgentKitPackageResult | null;
  isPreviewingPackage: boolean;
  isImporting: boolean;
  isSelectingDestination: boolean;
  isSelectingPackage: boolean;
  onAddInvalidImportAnyway: () => void;
  onImportPackage: () => void;
  onOpenImportedFolder: () => void;
  onPackageKit: (path: string) => void;
  onPreviewPackage: () => void;
  onSelectDestinationFolder: () => void;
  onSelectPackageFile: () => void;
  onUpdateForm: <Key extends keyof ImportPackagePanelProps["form"]>(
    key: Key,
    value: ImportPackagePanelProps["form"][Key],
  ) => void;
  onUseKit: (path: string) => void;
  packagePreview: AgentKitPackagePreview | null;
  previewError: string | null;
}) {
  const hasDuplicateWarning = Boolean(packagePreview?.duplicateWarnings.length);
  const sourceLabel = packagePreview?.packageMetadata.sourceLabel || packagePreview?.packageMetadata.source || "Local package";

  return (
    <div className="form-panel import-panel">
      <h2>Import .agentkit.zip</h2>
      <p className="form-copy">Bring in a portable Agent Kit package, validate it, and add it to My Kits.</p>

      <LabelWithHelp htmlFor="import-package-file" label="Package file" help="Choose the .agentkit.zip file you received or exported." />
      <div className="friendly-location-row">
        <span>Selected package: {form.packagePath ? friendlyFileName(form.packagePath) : "None selected"}</span>
        <button className="secondary-button compact-button" disabled={isSelectingPackage || isImporting} onClick={onSelectPackageFile} type="button">
          <FileArchive size={18} />
          Choose package
        </button>
      </div>
      <details className="advanced-details">
        <summary>Show full path</summary>
        <input
          id="import-package-file"
          onChange={(event) => onUpdateForm("packagePath", event.target.value)}
          placeholder="Full package path"
          value={form.packagePath}
        />
      </details>

      <div className="button-row">
        <button className="secondary-button compact-button" disabled={isPreviewingPackage || isImporting || !form.packagePath.trim()} onClick={onPreviewPackage} type="button">
          {isPreviewingPackage && <InlineSpinner className="button-spinner" />}
          Preview package
        </button>
      </div>

      {previewError && (
        <div className="error-state" role="alert">
          {previewError}
        </div>
      )}

      {packagePreview && (
        <div className="import-preview">
          <div className="status-banner valid">
            <strong>Package preview</strong>
            <span>Source: {sourceLabel}</span>
          </div>
          <dl className="report-meta">
            <div>
              <dt>Kit</dt>
              <dd>{packagePreview.packageMetadata.kitName || "Unnamed kit"} {formatDisplayVersion(packagePreview.packageMetadata.version)}</dd>
            </div>
            <div>
              <dt>Schema</dt>
              <dd>{packagePreview.packageMetadata.schemaVersion || "Not specified"}</dd>
            </div>
            <div>
              <dt>Package</dt>
              <dd>{packagePreview.packageMetadata.packageFileName || friendlyFileName(packagePreview.packagePath)}</dd>
            </div>
            {packagePreview.packageMetadata.sha256 && (
              <div>
                <dt>SHA-256</dt>
                <dd>{packagePreview.packageMetadata.sha256.slice(0, 16)}...</dd>
              </div>
            )}
            {packagePreview.packageMetadata.sourceMarketSlug && (
              <div>
                <dt>Market slug</dt>
                <dd>{packagePreview.packageMetadata.sourceMarketSlug}</dd>
              </div>
            )}
          </dl>
          {hasDuplicateWarning && (
            <div className="inline-warning">
              This package appears to match an existing My Kits entry. Choose Import as copy to keep both copies.
            </div>
          )}
        </div>
      )}

      <LabelWithHelp htmlFor="import-destination-folder" label="Destination" help="Imported kits are extracted into the AgentKitForge Library by default." />
      <div className="friendly-location-row">
        <span>Destination: {isDefaultKitsFolder(form.destinationRootFolder) ? "AgentKitForge Library" : friendlyLocation(form.destinationRootFolder)}</span>
        <button className="secondary-button compact-button" disabled={isSelectingDestination || isImporting} onClick={onSelectDestinationFolder} type="button">
          <FolderOpen size={18} />
          Change destination
        </button>
      </div>
      <details className="advanced-details">
        <summary>Show folder path</summary>
        <input
          id="import-destination-folder"
          onChange={(event) => onUpdateForm("destinationRootFolder", event.target.value)}
          placeholder="Full destination folder path"
          value={form.destinationRootFolder}
        />
      </details>

      <LabelWithHelp htmlFor="import-validation-profile" label="Validation level" help="Choose how strict the import check should be." />
      <select
        id="import-validation-profile"
        onChange={(event) => onUpdateForm("validationProfile", event.target.value as ValidationProfile)}
        value={form.validationProfile}
      >
        {validationProfiles.map((profile) => (
          <option key={profile} value={profile}>
            {profile}
          </option>
        ))}
      </select>

      <label className="checkbox-row" htmlFor="import-force">
        <input
          checked={form.force}
          id="import-force"
          onChange={(event) => onUpdateForm("force", event.target.checked)}
          type="checkbox"
        />
        <span>Force overwrite existing import folder</span>
      </label>

      {hasDuplicateWarning && (
        <label className="checkbox-row" htmlFor="import-as-copy">
          <input
            checked={form.importAsCopy}
            id="import-as-copy"
            onChange={(event) => onUpdateForm("importAsCopy", event.target.checked)}
            type="checkbox"
          />
          <span>Import as copy</span>
        </label>
      )}

      <button className="primary-button" disabled={isImporting || (hasDuplicateWarning && !form.importAsCopy && !form.force)} onClick={onImportPackage} type="button">
        <PackageOpen size={18} />
        {isImporting && <InlineSpinner className="button-spinner" />}
        {isImporting ? "Importing" : "Import package"}
      </button>
      {isImporting && <LoadingStatus text="Importing package and validating kit..." />}

      {importError && (
        <div className="error-state" role="alert">
          {importError}
        </div>
      )}

      {importResult && (
        <div className="import-result">
          <div className={`status-banner ${importResult.validationReport.valid ? "valid" : "invalid"}`}>
            <strong>{importResult.validationReport.valid ? "Imported and valid" : "Imported with issues"}</strong>
            <span>{importResult.validationReport.profile}</span>
          </div>
          <dl className="report-meta">
            <div>
              <dt>Kit</dt>
              <dd>{importResult.metadata.name} {formatDisplayVersion(importResult.metadata.version)}</dd>
            </div>
            <div>
              <dt>Validation</dt>
              <dd>{importResult.validationReport.valid ? "Valid" : "Needs review"}</dd>
            </div>
            <div>
              <dt>My Kits</dt>
              <dd>Added automatically</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{importResult.packageMetadata.sourceLabel || importResult.packageMetadata.source || "Local package"}</dd>
            </div>
            {importResult.packageMetadata.sha256 && (
              <div>
                <dt>SHA-256</dt>
                <dd>{importResult.packageMetadata.sha256.slice(0, 16)}...</dd>
              </div>
            )}
            <div>
              <dt>Location</dt>
              <dd>{friendlyLocation(importResult.extractedPath)}</dd>
            </div>
          </dl>
          <details className="advanced-details">
            <summary>Advanced details</summary>
            <dl className="report-meta">
              <div>
                <dt>Full folder path</dt>
                <dd>{importResult.extractedPath}</dd>
              </div>
            </dl>
          </details>
          {!importResult.validationReport.valid && (
            <>
              <IssueGroup issues={importResult.validationReport.issues.filter((issue) => issue.severity === "error")} severity="error" />
              <button className="secondary-button compact-button" onClick={onAddInvalidImportAnyway} type="button">
                Add to My Kits anyway
              </button>
            </>
          )}
          <div className="button-row">
            <button className="primary-button compact-button" disabled={!importResult.validationReport.valid} onClick={() => onUseKit(importResult.extractedPath)} type="button">Use Kit</button>
            <button className="secondary-button compact-button" onClick={() => onPackageKit(importResult.extractedPath)} type="button">Package / Export</button>
            <button className="secondary-button compact-button" onClick={onOpenImportedFolder} type="button">Open Folder</button>
          </div>
          <details className="advanced-details">
            <summary>Extracted files</summary>
            <div className="created-files">
              <ul>
                {importResult.files.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

type ImportPackagePanelProps = {
  form: {
    packagePath: string;
    destinationRootFolder: string;
    force: boolean;
    importAsCopy: boolean;
    validationProfile: ValidationProfile;
  };
};

function ImportFolderPanel({
  error,
  folderPath,
  inspection,
  isLoading,
  onAddAnyway,
  onOpenFolder,
  onPackageKit,
  onSelectFolder,
  onUseKit,
  validationReport,
}: {
  error: string | null;
  folderPath: string;
  inspection: AgentKitCandidateInspection | null;
  isLoading: boolean;
  onAddAnyway: () => void;
  onOpenFolder: () => void;
  onPackageKit: (path: string) => void;
  onSelectFolder: () => void;
  onUseKit: (path: string) => void;
  validationReport: ValidationReport | null;
}) {
  const isValid = Boolean(validationReport?.valid);

  return (
    <div className="form-panel import-panel">
      <h2>Import from Folder</h2>
      <p className="form-copy">
        Add an existing Agent Kit folder to My Kits. AgentKitForge checks the folder first so missing files are easier to fix.
      </p>

      <div className="friendly-location-row">
        <span>Selected folder: {folderPath ? friendlyLocation(folderPath) : "None selected"}</span>
        <button className="secondary-button compact-button" disabled={isLoading} onClick={onSelectFolder} type="button">
          <FolderOpen size={18} />
          Choose folder
        </button>
      </div>
      {folderPath && (
        <details className="advanced-details">
          <summary>Show full path</summary>
          <dl className="report-meta">
            <div>
              <dt>Full folder path</dt>
              <dd>{folderPath}</dd>
            </div>
          </dl>
        </details>
      )}

      {isLoading && <LoadingStatus text="Inspecting folder..." />}
      {error && <div className="error-state" role="alert">{error}</div>}

      {inspection && !inspection.looksLikeAgentKit && (
        <CandidateInspectionPanel inspection={inspection} title="This folder does not look like an Agent Kit." />
      )}

      {inspection?.looksLikeAgentKit && validationReport && (
        <div className="import-result">
          <div className={`status-banner ${isValid ? "valid" : "invalid"}`}>
            <strong>{isValid ? "Folder added to My Kits" : "Folder needs attention"}</strong>
            <span>{validationReport.profile}</span>
          </div>
          <dl className="report-meta">
            <div>
              <dt>Location</dt>
              <dd>{friendlyLocation(folderPath)}</dd>
            </div>
            <div>
              <dt>Validation</dt>
              <dd>{isValid ? "Valid" : "Needs review"}</dd>
            </div>
            <div>
              <dt>Skills found</dt>
              <dd>{inspection.foundSkills.length}</dd>
            </div>
          </dl>
          {!isValid && (
            <>
              <IssueGroup issues={validationReport.issues.filter((issue) => issue.severity === "error")} severity="error" />
              <button className="secondary-button compact-button" onClick={onAddAnyway} type="button">
                Add to My Kits anyway
              </button>
            </>
          )}
          <div className="button-row">
            <button className="primary-button compact-button" disabled={!isValid} onClick={() => onUseKit(folderPath)} type="button">
              Use Kit
            </button>
            <button className="secondary-button compact-button" disabled={!folderPath} onClick={() => onPackageKit(folderPath)} type="button">
              Package / Export
            </button>
            <button className="secondary-button compact-button" disabled={!folderPath} onClick={onOpenFolder} type="button">
              Open Folder
            </button>
          </div>
          <CandidateInspectionPanel inspection={inspection} title="Folder inspection" compact />
        </div>
      )}

      <div className="help-link-row">
        <button onClick={() => openDocsLink("https://forge.agentkitproject.com/docs/")} type="button">Import docs</button>
        <button onClick={() => openDocsLink("https://forge.agentkitproject.com/agent-kit-spec/")} type="button">Agent Kit Spec</button>
      </div>
    </div>
  );
}

function ImportGitPanel({
  error,
  form,
  isImporting,
  isSelectingDestination,
  onImport,
  onOpenFolder,
  onPackageKit,
  onSelectDestination,
  onUpdateForm,
  onUseKit,
  result,
  technicalError,
}: {
  error: string | null;
  form: {
    repositoryUrl: string;
    reference: string;
    destinationRootFolder: string;
    validationProfile: ValidationProfile;
  };
  isImporting: boolean;
  isSelectingDestination: boolean;
  onImport: () => void;
  onOpenFolder: (path: string) => void;
  onPackageKit: (path: string) => void;
  onSelectDestination: () => void;
  onUpdateForm: <Key extends keyof ImportGitPanelProps["form"]>(
    key: Key,
    value: ImportGitPanelProps["form"][Key],
  ) => void;
  onUseKit: (path: string) => void;
  result: ImportAgentKitFromGitResult | null;
  technicalError: string | null;
}) {
  const importedPath = result?.importedPath || "";
  const isValid = Boolean(result?.validationReport?.valid);

  return (
    <div className="form-panel import-panel">
      <h2>Import from Git Repository</h2>
      <p className="form-copy">
        Import a repository whose root folder is an Agent Kit. AgentKitForge uses your local Git configuration for private repositories.
      </p>

      <LabelWithHelp htmlFor="git-repository-url" label="Git repository URL" help="Use an HTTPS or SSH URL from GitHub, GitLab, Bitbucket, or another Git host." />
      <input
        id="git-repository-url"
        onChange={(event) => onUpdateForm("repositoryUrl", event.target.value)}
        placeholder="https://github.com/example/agent-kit.git or git@github.com:org/repo.git"
        value={form.repositoryUrl}
      />

      <LabelWithHelp htmlFor="git-auth-method" label="Authentication method" help="AgentKitForge lets local Git handle SSH keys and credential managers." />
      <select id="git-auth-method" value="local-git" disabled>
        <option value="local-git">Use my local Git credentials</option>
      </select>
      <p className="form-copy">
        AgentKitForge uses your local Git configuration for private repositories. If you can clone this repo from your terminal,
        AgentKitForge should usually be able to import it.
      </p>

      <LabelWithHelp htmlFor="git-reference" label="Branch or ref" help="Optional. Leave blank to import the repository default branch." />
      <input
        id="git-reference"
        onChange={(event) => onUpdateForm("reference", event.target.value)}
        placeholder="main"
        value={form.reference}
      />

      <LabelWithHelp htmlFor="git-import-destination" label="Destination" help="Git imports are copied into the AgentKitForge Library by default." />
      <div className="friendly-location-row">
        <span>Destination: {isDefaultKitsFolder(form.destinationRootFolder) ? "AgentKitForge Library" : friendlyLocation(form.destinationRootFolder)}</span>
        <button className="secondary-button compact-button" disabled={isSelectingDestination || isImporting} onClick={onSelectDestination} type="button">
          <FolderOpen size={18} />
          Change destination
        </button>
      </div>
      <details className="advanced-details">
        <summary>Show folder path</summary>
        <input
          id="git-import-destination"
          onChange={(event) => onUpdateForm("destinationRootFolder", event.target.value)}
          placeholder="Full destination folder path"
          value={form.destinationRootFolder}
        />
      </details>

      <LabelWithHelp htmlFor="git-validation-profile" label="Validation level" help="Choose how strict the imported repository should be checked." />
      <select
        id="git-validation-profile"
        onChange={(event) => onUpdateForm("validationProfile", event.target.value as ValidationProfile)}
        value={form.validationProfile}
      >
        {validationProfiles.map((profile) => (
          <option key={profile} value={profile}>
            {profile}
          </option>
        ))}
      </select>

      <button className="primary-button" disabled={isImporting} onClick={onImport} type="button">
        <GitBranch size={18} />
        {isImporting && <InlineSpinner className="button-spinner" />}
        {isImporting ? "Importing" : "Import repository"}
      </button>
      {isImporting && <LoadingStatus text="Cloning repository, inspecting files, and validating kit..." />}

      {error && (
        <div className="error-state" role="alert">
          <strong>{error}</strong>
          {technicalError && (
            <>
              <p>Try these checks:</p>
              <ul>
                <li>Confirm Git is installed.</li>
                <li>Confirm you can clone this repo from your terminal.</li>
                <li>Check your SSH key or Git credential manager.</li>
                <li>Use an HTTPS or SSH URL you have access to.</li>
                <li>Check the branch or ref.</li>
              </ul>
              <details className="advanced-details compact-advanced">
                <summary>Show technical Git error</summary>
                <pre className="json-panel">{technicalError}</pre>
              </details>
            </>
          )}
        </div>
      )}

      {result && !result.inspection.looksLikeAgentKit && (
        <CandidateInspectionPanel inspection={result.inspection} title="This repository does not look like an Agent Kit." />
      )}

      {result?.inspection.looksLikeAgentKit && result.validationReport && (
        <div className="import-result">
          <div className={`status-banner ${isValid ? "valid" : "invalid"}`}>
            <strong>{isValid ? "Imported and added to My Kits" : "Imported with issues"}</strong>
            <span>{result.validationReport.profile}</span>
          </div>
          <dl className="report-meta">
            <div>
              <dt>Repository</dt>
              <dd>{friendlyGitRepoLabel(result.repositoryUrl)}</dd>
            </div>
            <div>
              <dt>Kit</dt>
              <dd>{result.metadata ? `${result.metadata.name} ${formatDisplayVersion(result.metadata.version)}` : "Imported kit"}</dd>
            </div>
            <div>
              <dt>Location</dt>
              <dd>{importedPath ? friendlyLocation(importedPath) : "Not imported"}</dd>
            </div>
            <div>
              <dt>Validation</dt>
              <dd>{isValid ? "Valid" : "Needs review"}</dd>
            </div>
          </dl>
          {result.warnings.length > 0 && (
            <div className="inline-warning">
              {result.warnings.map((warning) => (
                <div key={warning}>{warning}</div>
              ))}
            </div>
          )}
          {importedPath && (
            <details className="advanced-details">
              <summary>Advanced details</summary>
              <dl className="report-meta">
                <div>
                  <dt>Full folder path</dt>
                  <dd>{importedPath}</dd>
                </div>
              </dl>
            </details>
          )}
          {!isValid && (
            <IssueGroup issues={result.validationReport.issues.filter((issue) => issue.severity === "error")} severity="error" />
          )}
          <div className="button-row">
            <button className="primary-button compact-button" disabled={!isValid || !importedPath} onClick={() => onUseKit(importedPath)} type="button">
              Use Kit
            </button>
            <button className="secondary-button compact-button" disabled={!importedPath} onClick={() => onPackageKit(importedPath)} type="button">
              Package / Export
            </button>
            <button className="secondary-button compact-button" disabled={!importedPath} onClick={() => onOpenFolder(importedPath)} type="button">
              Open Folder
            </button>
          </div>
          <details className="advanced-details">
            <summary>Imported files</summary>
            <div className="created-files">
              <ul>
                {result.files.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

type ImportGitPanelProps = {
  form: {
    repositoryUrl: string;
    reference: string;
    destinationRootFolder: string;
    validationProfile: ValidationProfile;
  };
};

function CandidateInspectionPanel({
  compact = false,
  inspection,
  title,
}: {
  compact?: boolean;
  inspection: AgentKitCandidateInspection;
  title: string;
}) {
  const hasMissing = inspection.missingRequiredFiles.length > 0 || inspection.missingRequiredFolders.length > 0;

  return (
    <div className={compact ? "inline-inspection" : "error-state"} role={compact ? undefined : "alert"}>
      <strong>{title}</strong>
      <p>{inspection.friendlySummary}</p>
      {hasMissing && (
        <div className="inspection-grid">
          {inspection.missingRequiredFiles.length > 0 && (
            <div>
              <h3>Missing files</h3>
              <ul>
                {inspection.missingRequiredFiles.map((file) => (
                  <li key={file}>{friendlyValidationLabel(file)}</li>
                ))}
              </ul>
            </div>
          )}
          {inspection.missingRequiredFolders.length > 0 && (
            <div>
              <h3>Missing folders</h3>
              <ul>
                {inspection.missingRequiredFolders.map((folder) => (
                  <li key={folder}>{friendlyValidationLabel(folder)}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {inspection.recommendedFixes.length > 0 && (
        <div>
          <h3>Recommended fixes</h3>
          <ul>
            {inspection.recommendedFixes.map((fix) => (
              <li key={fix}>{fix}</li>
            ))}
          </ul>
        </div>
      )}
      <details className="advanced-details">
        <summary>Advanced details</summary>
        <dl className="report-meta">
          <div>
            <dt>Full folder path</dt>
            <dd>{inspection.path}</dd>
          </div>
          <div>
            <dt>Files found</dt>
            <dd>{inspection.foundFiles.length ? inspection.foundFiles.join(", ") : "None"}</dd>
          </div>
          <div>
            <dt>Skills found</dt>
            <dd>{inspection.foundSkills.length ? inspection.foundSkills.join(", ") : "None"}</dd>
          </div>
        </dl>
      </details>
    </div>
  );
}

function ComingSoonImportPanel({ title }: { title: string }) {
  return (
    <div className="form-panel import-panel">
      <div className="empty-state compact-empty">
        <PackageOpen size={34} strokeWidth={1.8} />
        <h2>{title}</h2>
        <p>This import source is coming later. For v0.1, use a package, folder, or public Git repository.</p>
      </div>
      <div className="help-link-row">
        <button onClick={() => openDocsLink("https://forge.agentkitproject.com/docs/")} type="button">Import docs</button>
        <button onClick={() => openDocsLink("https://forge.agentkitproject.com/agent-kit-spec/")} type="button">Agent Kit Spec</button>
      </div>
    </div>
  );
}

function MarketImportPanel({
  accountConnection,
  deepLinkError,
  initialRequest,
  onKitImported,
  onAccountReconnectRequired,
  onOpenAccount,
  onOpenMyKits,
  onOpenZipImport,
  onSettingsChange,
  onUseKit,
}: {
  accountConnection: AccountConnection;
  deepLinkError: string | null;
  initialRequest: MarketImportRequest | null;
  onKitImported: (path: string) => void;
  onAccountReconnectRequired: (message: string) => void;
  onOpenAccount: () => void;
  onOpenMyKits: () => void;
  onOpenZipImport: () => void;
  onSettingsChange: (settings: PublicSettings) => void;
  onUseKit: (path: string) => void;
}) {
  const isConnected = accountConnection.accountConnectionStatus === "connected";
  const hostedMarket = defaultExternalServiceConnections.find((connection) => connection.id === "agentkitproject-market");
  const privateMarket = defaultExternalServiceConnections.find((connection) => connection.id === "private-market-placeholder");
  const [marketBaseUrl, setMarketBaseUrl] = useState(hostedMarket?.baseUrl || agentKitProjectUrls.market);
  const [marketReference, setMarketReference] = useState("");
  const [identifierKind, setIdentifierKind] = useState<MarketIdentifierKind>("kit");
  const [requiresConfirmation, setRequiresConfirmation] = useState(false);
  const [phase, setPhase] = useState<HostedMarketImportPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportAgentKitPackageResult | null>(null);
  const [licensedResult, setLicensedResult] = useState<FetchLicensedMarketKitResult | null>(null);
  // The public slug of the last licensed/online-only kit, for the run-online
  // handoff deep links (web Forge / Auto). Derived from the request, not content.
  const [licensedSlug, setLicensedSlug] = useState<string | null>(null);
  const [licensedFetching, setLicensedFetching] = useState(false);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [favoriteMessage, setFavoriteMessage] = useState<string | null>(null);
  const isImporting = ["requesting", "downloading", "verifying", "importing", "validating"].includes(phase);
  const selectedHostedMarket = isHostedAgentKitMarket(marketBaseUrl);

  // Favorite the referenced hosted-Market kit (opt-in; account-connected only).
  async function favoriteHostedMarketKit() {
    const reference = marketReference.trim();
    if (!reference) {
      setError("Enter a Market kit URL, slug, or ID before favoriting.");
      return;
    }
    setFavoriteBusy(true);
    setFavoriteMessage(null);
    setError(null);
    try {
      const input =
        identifierKind === "kitId" ? { kitId: reference } : { slug: reference };
      await forge.addCloudFavorite(input);
      setFavoriteMessage("Added to your synced favorites.");
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    } finally {
      setFavoriteBusy(false);
    }
  }

  useEffect(() => {
    if (!initialRequest) {
      return;
    }
    setMarketBaseUrl(initialRequest.marketBaseUrl);
    setMarketReference(initialRequest.identifier);
    setIdentifierKind(initialRequest.identifierKind);
    setRequiresConfirmation(initialRequest.requiresConfirmation);
    setPhase("idle");
    setResult(null);
    setError(null);
  }, [initialRequest]);

  async function importFromHostedMarket() {
    setError(null);
    setResult(null);
    const parsed = normalizeMarketImportReference(marketReference, marketBaseUrl);
    if (!parsed.ok) {
      setPhase("failed");
      setError(parsed.error);
      return;
    }
    const request: MarketImportRequest = {
      ...parsed.request,
      identifierKind: identifierKind === "kitId" ? "kitId" : parsed.request.identifierKind,
    };
    setMarketBaseUrl(request.marketBaseUrl);
    setMarketReference(request.identifier);
    setIdentifierKind(request.identifierKind);
    if (!isHostedAgentKitMarket(request.marketBaseUrl)) {
      setPhase("failed");
      setError("Private Market import will use this Market's own credentials. Coming soon.");
      return;
    }

    let restoredSettings: PublicSettings;
    try {
      restoredSettings = await forge.restoreAgentKitProjectAccount();
      onSettingsChange(restoredSettings);
    } catch (caughtError) {
      setPhase("failed");
      const message = errorToMessage(caughtError);
      onAccountReconnectRequired(reconnectRequiredMessage());
      setError(`Unable to verify AgentKitProject session before Market import: ${message}`);
      return;
    }

    if (restoredSettings.accountConnection.accountConnectionStatus !== "connected") {
      const reconnectMessage = reconnectRequiredMessage();
      setPhase("failed");
      onAccountReconnectRequired(reconnectMessage);
      setError(reconnectMessage);
      return;
    }
    setRequiresConfirmation(false);

    try {
      setPhase("requesting");
      await waitForUiProgress();
      setPhase("downloading");
      const importPromise = forge.importHostedMarketKit({
          slug: request.identifierKind === "kit" ? request.identifier : "",
          kitId: request.identifierKind === "kitId" ? request.identifier : undefined,
          marketBaseUrl: request.marketBaseUrl,
          validationProfile: "local-valid",
        });
      await waitForUiProgress();
      setPhase("verifying");
      await waitForUiProgress();
      setPhase("importing");
      await waitForUiProgress();
      setPhase("validating");
      const importResult = await importPromise;
      setResult(importResult);
      setPhase("success");
      onKitImported(importResult.extractedPath);
    } catch (caughtError) {
      setPhase("failed");
      const message = errorToMessage(caughtError);
      if (isReconnectRequiredError(message)) {
        const reconnectMessage = reconnectRequiredMessage();
        onAccountReconnectRequired(reconnectMessage);
        setError(reconnectMessage);
      } else {
        setError(message);
      }
    }
  }

  // Tier-2 paid/licensed kit consumption. Fetches the entitlement-gated,
  // watermarked package via core (held in memory). For ONLINE-ONLY kits the
  // bytes never reach disk — we only get a read-only preview and BLOCK every
  // save/export. For downloadable paid kits the user owns, the watermarked
  // bytes are saved to My Kits (handled in Rust). Free kits use Direct import.
  async function fetchLicensedKit() {
    setError(null);
    setResult(null);
    setLicensedResult(null);
    setLicensedSlug(null);
    const parsed = normalizeMarketImportReference(marketReference, marketBaseUrl);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const request: MarketImportRequest = {
      ...parsed.request,
      identifierKind: identifierKind === "kitId" ? "kitId" : parsed.request.identifierKind,
    };
    // Remember the public slug (if the reference is a slug) so the online-only
    // handoff can build run links even when no content is returned (Slice 1:
    // protected kits refuse content with a 402 directive).
    setLicensedSlug(request.identifierKind === "kit" ? request.identifier : null);
    if (!isHostedAgentKitMarket(request.marketBaseUrl)) {
      setError("Private Market licensed kits will use this Market's own credentials. Coming soon.");
      return;
    }
    if (!isConnected) {
      const reconnectMessage = reconnectRequiredMessage();
      onAccountReconnectRequired(reconnectMessage);
      setError(reconnectMessage);
      return;
    }
    try {
      setLicensedFetching(true);
      const fetched = await forge.fetchLicensedMarketKit({
          slug: request.identifierKind === "kit" ? request.identifier : "",
          kitId: request.identifierKind === "kitId" ? request.identifier : undefined,
          marketBaseUrl: request.marketBaseUrl,
          validationProfile: "local-valid",
        });
      setLicensedResult(fetched);
      if (fetched.imported) {
        onKitImported(fetched.imported.extractedPath);
      }
    } catch (caughtError) {
      const message = errorToMessage(caughtError);
      if (isReconnectRequiredError(message)) {
        const reconnectMessage = reconnectRequiredMessage();
        onAccountReconnectRequired(reconnectMessage);
        setError(reconnectMessage);
      } else if (isOnlineOnlyRefusal(caughtError, message)) {
        // Slice 1: a protected (output-only) kit refuses content with a 402
        // directive. Don't treat it as an error — show the run-online handoff
        // (no content reached the client). Synthesize an online-only result so
        // the handoff panel renders; the run links use the remembered slug.
        setLicensedResult({
          onlineOnly: true,
          pricing: "paid",
          downloadable: false,
          kitId: extractOnlineOnlyKitId(caughtError) ?? "",
          sha256: "",
          preview: { files: [], texts: {} },
          imported: null,
          message: "This kit is output-only — run it online.",
        });
      } else {
        setError(message);
      }
    } finally {
      setLicensedFetching(false);
    }
  }

  return (
    <div className="form-panel import-panel" data-testid="market-import-panel">
      <div className="provider-card-header">
        <div>
          <h2>Market sources</h2>
          <p>AgentKitForge works locally. Market connections are optional. Manual .agentkit.zip import works without any Market connection.</p>
        </div>
        <span className="provider-badge">Optional</span>
      </div>

      <dl className="report-meta">
        <div>
          <dt>AgentKitProject account</dt>
          <dd>{isConnected ? "Connected" : "Not connected"}</dd>
        </div>
        <div>
          <dt>Manual package import</dt>
          <dd>{canUseManualPackageImport() ? "Available without login" : "Unavailable"}</dd>
        </div>
        <div>
          <dt>Direct import</dt>
          <dd>{isConnected ? "Available for hosted AgentKitMarket" : "Requires connected AgentKitProject account"}</dd>
        </div>
      </dl>

      <div className="provider-card compact-service-card" data-testid="hosted-market-source">
        <div className="provider-card-header">
          <div>
            <h3>Hosted AgentKitMarket</h3>
            <p>Download kits from Market and import them into Forge.</p>
          </div>
          <span className="provider-badge">{hostedMarket?.status === "disabled" ? "Disabled" : "Browse available"}</span>
        </div>
        <dl className="report-meta">
          <div>
            <dt>Base URL</dt>
            <dd>{hostedMarket?.baseUrl || agentKitProjectUrls.market}</dd>
          </div>
          <div>
            <dt>Auth</dt>
            <dd>AgentKitProject account for hosted services</dd>
          </div>
          <div>
            <dt>Import</dt>
            <dd>{isConnected ? "Direct download enabled" : "Connect account to import directly"}</dd>
          </div>
        </dl>
        <label className="field-label" htmlFor="market-base-url">Market source</label>
        <input
          disabled={isImporting}
          id="market-base-url"
          onChange={(event) => {
            setMarketBaseUrl(event.target.value);
            setError(null);
            setRequiresConfirmation(false);
          }}
          placeholder="https://market.agentkitproject.com"
          type="url"
          value={marketBaseUrl}
        />
        <label className="field-label" htmlFor="hosted-market-kit-reference">Market kit URL, slug, or ID</label>
        <input
          disabled={isImporting}
          id="hosted-market-kit-reference"
          onChange={(event) => {
            setMarketReference(event.target.value);
            setIdentifierKind("kit");
            setError(null);
            setRequiresConfirmation(false);
            if (phase === "failed" || phase === "success") {
              setPhase("idle");
              setResult(null);
            }
          }}
          placeholder="https://market.agentkitproject.com/kits/example-kit-slug, example-kit-slug, or kit_123"
          value={marketReference}
        />
        <select
          disabled={isImporting}
          onChange={(event) => setIdentifierKind(event.target.value as MarketIdentifierKind)}
          value={identifierKind}
        >
          <option value="kit">Slug / URL</option>
          <option value="kitId">Kit ID</option>
        </select>
        {!isConnected && (
          <div className="inline-warning">
            Connect AgentKitProject account to download directly from hosted AgentKitMarket.
          </div>
        )}
        {!selectedHostedMarket && (
          <div className="inline-warning">
            Private Market import will use this Market's own credentials. Coming soon.
          </div>
        )}
      </div>

      <div className="provider-card compact-service-card" data-testid="private-market-source">
        <div className="provider-card-header">
          <div>
            <h3>Private/self-hosted markets coming later</h3>
            <p>Private markets use their own credentials and identity provider. An AgentKitProject account is not required unless that market chooses it.</p>
          </div>
          <span className="provider-badge">Coming soon</span>
        </div>
        <label className="field-label" htmlFor="private-market-base-url-preview">Private Market base URL</label>
        <input
          disabled
          id="private-market-base-url-preview"
          placeholder="https://market.company.example"
          type="url"
          value={privateMarket?.baseUrl || ""}
        />
      </div>

      <div className="inline-warning">
        Downloading from hosted Market may require an AgentKitProject account. Importing a downloaded .agentkit.zip in Forge does not require login.
      </div>
      <p className="form-copy">
        Direct import from hosted Market uses your connected AgentKitProject account. Private markets will use their own auth later.
      </p>
      {deepLinkError && (
        <div className="error-state" role="alert">
          {deepLinkError}
        </div>
      )}
      {requiresConfirmation && (
        <div className="inline-warning" data-testid="market-import-confirmation">
          Import this kit from {marketBaseUrl}?
        </div>
      )}

      {phase !== "idle" && (
        <dl className="report-meta" data-testid="hosted-market-import-progress">
          <div>
            <dt>Requesting download</dt>
            <dd>{marketPhaseStatus(phase, "requesting")}</dd>
          </div>
          <div>
            <dt>Downloading</dt>
            <dd>{marketPhaseStatus(phase, "downloading")}</dd>
          </div>
          <div>
            <dt>Verifying</dt>
            <dd>{marketPhaseStatus(phase, "verifying")}</dd>
          </div>
          <div>
            <dt>Importing</dt>
            <dd>{marketPhaseStatus(phase, "importing")}</dd>
          </div>
          <div>
            <dt>Validating</dt>
            <dd>{marketPhaseStatus(phase, "validating")}</dd>
          </div>
          <div>
            <dt>My Kits</dt>
            <dd>{phase === "success" ? "Added to My Kits" : phase === "failed" ? "Not added" : "Waiting"}</dd>
          </div>
        </dl>
      )}
      {error && (
        <div className="error-state" role="alert">
          {error}
        </div>
      )}
      {result && (
        <div className="copy-state">
          Added {result.metadata.name} {formatDisplayVersion(result.metadata.version)} to My Kits.
        </div>
      )}
      {favoriteMessage && <div className="copy-state">{favoriteMessage}</div>}

      {licensedResult && licensedResult.onlineOnly && (
        // OUTPUT-ONLY (protected) kit: the content NEVER reaches this client
        // (Slice 1). Don't render any kit content — hand off to a run surface
        // (web Forge for interactive use, Auto for an autonomous run).
        <div className="provider-card compact-service-card" data-testid="online-only-run-handoff">
          <div className="provider-card-header">
            <div>
              <h3>This kit is output-only — run it online</h3>
              <p>
                {licensedResult.message ||
                  "Protected kits run server-side so their contents stay private. Open it on web Forge to use it interactively, or on Auto to run it autonomously."}
              </p>
            </div>
            <span className="provider-badge">Output-only</span>
          </div>
          <div className="button-row">
            <button
              className="primary-button"
              type="button"
              disabled={!licensedSlug}
              onClick={() =>
                openDocsLink(
                  buildRunOnlineUrl(agentKitProjectUrls.forge, "/forge", licensedSlug, licensedResult.kitId),
                )
              }
            >
              Run in Forge (web)
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={!licensedSlug}
              onClick={() =>
                openDocsLink(
                  buildRunOnlineUrl(agentKitProjectUrls.auto, "/", licensedSlug, licensedResult.kitId),
                )
              }
            >
              Run on Auto
            </button>
          </div>
        </div>
      )}

      {licensedResult && !licensedResult.onlineOnly && (
        <div className="provider-card compact-service-card" data-testid="licensed-kit-preview">
          <div className="provider-card-header">
            <div>
              <h3>Licensed kit</h3>
              <p>{licensedResult.message}</p>
            </div>
            <span className="provider-badge">Saved to My Kits</span>
          </div>
          {Object.entries(licensedResult.preview.texts).map(([name, content]) => (
            <details key={name} className="report-meta">
              <summary>{name}</summary>
              <pre className="code-preview">{content}</pre>
            </details>
          ))}
          {licensedResult.preview.files.length > 0 && (
            <details className="report-meta">
              <summary>Files ({licensedResult.preview.files.length})</summary>
              <ul>
                {licensedResult.preview.files.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <div className="button-row">
        <button className="primary-button" disabled={hostedMarket ? !canUseHostedMarketBrowse(hostedMarket) : false} onClick={() => openDocsLink(agentKitProjectUrls.marketKits)} type="button">
          Open Market in browser
        </button>
        {isConnected || !selectedHostedMarket ? (
          <button className="primary-button" disabled={isImporting} onClick={importFromHostedMarket} type="button">
            {isImporting ? "Importing from Market..." : requiresConfirmation ? "Confirm and import" : "Direct import from Market"}
          </button>
        ) : (
          <button className="secondary-button" onClick={onOpenAccount} type="button">
            Connect AgentKitProject account
          </button>
        )}
        <button className="secondary-button" onClick={onOpenZipImport} type="button">
          Import from .agentkit.zip
        </button>
        {isConnected && selectedHostedMarket && (
          <button
            className="secondary-button"
            data-testid="favorite-hosted-market-kit"
            disabled={favoriteBusy || isImporting || !marketReference.trim()}
            onClick={favoriteHostedMarketKit}
            type="button"
          >
            <Star size={16} />
            {favoriteBusy ? "Favoriting..." : "Favorite"}
          </button>
        )}
        {isConnected && selectedHostedMarket && (
          <button
            className="secondary-button"
            data-testid="fetch-licensed-kit"
            disabled={licensedFetching || isImporting}
            onClick={fetchLicensedKit}
            type="button"
          >
            {licensedFetching ? "Fetching licensed kit..." : "Open licensed/paid kit"}
          </button>
        )}
        {result && (
          <>
            <button className="secondary-button" onClick={onOpenMyKits} type="button">
              Open in My Kits
            </button>
            <button className="secondary-button" onClick={() => onUseKit(result.extractedPath)} type="button">
              Use Kit
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function isReconnectRequiredError(message: string) {
  return (
    message.includes("RECONNECT_REQUIRED") ||
    message.includes("AUTH_REQUIRED") ||
    message.includes("AgentKitProject session expired or is missing")
  );
}

function reconnectRequiredMessage() {
  return "Reconnect AgentKitProject account to download directly from hosted AgentKitMarket.";
}

function submitReconnectRequiredMessage() {
  return "Reconnect AgentKitProject account to submit to hosted AgentKitMarket.";
}

function waitForUiProgress() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 120));
}

function marketPhaseStatus(current: HostedMarketImportPhase, phase: HostedMarketImportPhase) {
  const order: HostedMarketImportPhase[] = ["requesting", "downloading", "verifying", "importing", "validating"];
  if (current === "success") {
    return "Complete";
  }
  if (current === "failed") {
    return "Stopped";
  }
  const currentIndex = order.indexOf(current);
  const phaseIndex = order.indexOf(phase);
  if (currentIndex === phaseIndex) {
    return "In progress";
  }
  if (currentIndex > phaseIndex) {
    return "Complete";
  }
  return "Waiting";
}

function submitPhaseStatus(current: MarketSubmitPhase, phase: MarketSubmitPhase) {
  const order: MarketSubmitPhase[] = ["validating", "packaging", "uploading", "creating"];
  if (current === "submitted") {
    return "Complete";
  }
  if (current === "failed") {
    return "Stopped";
  }
  const currentIndex = order.indexOf(current);
  const phaseIndex = order.indexOf(phase);
  if (phaseIndex < currentIndex) {
    return "Complete";
  }
  if (phaseIndex === currentIndex) {
    return "In progress";
  }
  return "Waiting";
}

function normalizeMarketStatusToken(value: string) {
  return value.trim().toLowerCase().replace(/[-\s]+/g, "_");
}

function formatMarketSubmissionStatus(status: string) {
  const normalized = normalizeMarketStatusToken(status);
  if (normalized in marketSubmissionStatusLabels) {
    return marketSubmissionStatusLabels[normalized as MarketSubmissionStatus];
  }
  return status.trim() || "Pending review";
}

function BuildScreen({
  onKitReady,
  onPackageKit,
  onUseKit,
  onValidateCreatedKit,
  settings,
}: {
  onKitReady: (rootPath: string) => void;
  onPackageKit: (rootPath: string) => void;
  onUseKit: (rootPath: string) => void;
  onValidateCreatedKit: (rootPath: string, profile: ValidationProfile) => void;
  settings: PublicSettings;
}) {
  const [form, setForm] = useState<CreateAgentKitInput>({
    outputFolder: settings.defaultOutputFolder,
    id: "",
    name: "",
    description: "",
    template: "blank",
    force: false,
  });
  const [result, setResult] = useState<CreateAgentKitResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof CreateAgentKitInput, string>>>(
    {},
  );
  const [isSelecting, setIsSelecting] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [draftForm, setDraftForm] = useState<RenderAgentKitDraftInput>({
    draftFilePath: "",
    outputFolder: settings.defaultOutputFolder,
    force: false,
  });
  const [draftResult, setDraftResult] = useState<RenderAgentKitDraftResult | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftFieldErrors, setDraftFieldErrors] = useState<
    Partial<Record<keyof RenderAgentKitDraftInput, string>>
  >({});
  const [isSelectingDraftFile, setIsSelectingDraftFile] = useState(false);
  const [isSelectingDraftOutput, setIsSelectingDraftOutput] = useState(false);
  const [isRenderingDraft, setIsRenderingDraft] = useState(false);
  const [aiForm, setAiForm] = useState<GenerateAgentKitDraftInput>({
    userRequest: "",
    targetUsers: "",
    domain: "",
    desiredValidationLevel: "local-valid",
    constraints: "",
    sourceNotes: "",
    requestedSections: defaultRequestedBuildSections(),
    excludedSections: defaultExcludedBuildSections(defaultRequestedBuildSections()),
    exampleInputDocuments: [],
    providerId: settings.defaultAiProviderId || "",
    model: settings.defaultModel || defaultRuntimeModel,
  });
  const [myKitsForBuild, setMyKitsForBuild] = useState<MyKitEntry[]>([]);
  const [editKitPath, setEditKitPath] = useState("");
  const [editDraftLoad, setEditDraftLoad] = useState<LoadAgentKitAsDraftResult | null>(null);
  const [editLoadError, setEditLoadError] = useState<string | null>(null);
  const [isLoadingEditDraft, setIsLoadingEditDraft] = useState(false);
  const [aiResult, setAiResult] = useState<GenerateAgentKitDraftResult | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [draftChangeRequest, setDraftChangeRequest] = useState("");
  const [isRevisingDraft, setIsRevisingDraft] = useState(false);
  const [aiFieldErrors, setAiFieldErrors] = useState<
    Partial<Record<keyof GenerateAgentKitDraftInput | "apiKey", string>>
  >({});
  const [isGeneratingDraft, setIsGeneratingDraft] = useState(false);
  const [isSelectingExampleDocuments, setIsSelectingExampleDocuments] = useState(false);
  const [draftCopyState, setDraftCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [draftSavePath, setDraftSavePath] = useState<string | null>(null);
  const [generatedRenderOutputFolder, setGeneratedRenderOutputFolder] = useState(
    settings.defaultOutputFolder,
  );
  const [generatedRenderForce, setGeneratedRenderForce] = useState(false);
  const [generatedRenderResult, setGeneratedRenderResult] =
    useState<RenderAgentKitDraftResult | null>(null);
  const [generatedRenderError, setGeneratedRenderError] = useState<string | null>(null);
  const [isSelectingGeneratedRenderOutput, setIsSelectingGeneratedRenderOutput] = useState(false);
  const [isRenderingGeneratedDraft, setIsRenderingGeneratedDraft] = useState(false);
  const [activeBuildTab, setActiveBuildTab] = useState<BuildTabId>(() => {
    const saved = window.localStorage.getItem("agentkitforge.lastBuildTab") as BuildTabId | null;
    return saved && buildModes.some((tab) => tab.id === saved) ? saved : "ai";
  });
  const [activeBuildGroup, setActiveBuildGroup] = useState<BuildModeGroup>(() => {
    const saved = window.localStorage.getItem("agentkitforge.lastBuildTab") as BuildTabId | null;
    return saved && buildModes.some((tab) => tab.id === saved) ? buildModeGroupForTab(saved) : "Create New";
  });
  const [guidedStep, setGuidedStep] = useState<GuidedBuilderStep>("basics");
  const [guidedForm, setGuidedForm] = useState<GuidedBuilderState>(() =>
    createDefaultGuidedBuilderState(settings.defaultOutputFolder),
  );
  const [guidedError, setGuidedError] = useState<string | null>(null);
  const [guidedResult, setGuidedResult] = useState<RenderAgentKitDraftResult | null>(null);
  const [guidedValidationReport, setGuidedValidationReport] = useState<ValidationReport | null>(null);
  const [isCreatingGuidedKit, setIsCreatingGuidedKit] = useState(false);
  const [isSelectingGuidedOutput, setIsSelectingGuidedOutput] = useState(false);

  function selectBuildTab(tabId: BuildTabId) {
    setActiveBuildTab(tabId);
    setActiveBuildGroup(buildModeGroupForTab(tabId));
    window.localStorage.setItem("agentkitforge.lastBuildTab", tabId);
  }

  function selectBuildGroup(group: BuildModeGroup) {
    setActiveBuildGroup(group);
    if (buildModeGroupForTab(activeBuildTab) !== group) {
      selectBuildTab(group === "Create New" ? "ai" : "edit-ai");
    }
  }

  useEffect(() => {
    forge.listMyKits()
      .then(setMyKitsForBuild)
      .catch(() => setMyKitsForBuild([]));
  }, []);

  function updateBuildSections(sectionId: string, selected: boolean) {
    const required = requiredBuildSections.includes(sectionId);
    if (required) {
      return;
    }
    setAiForm((current) => {
      const requestedSections = selected
        ? Array.from(new Set([...current.requestedSections, sectionId]))
        : current.requestedSections.filter((section) => section !== sectionId);
      return {
        ...current,
        requestedSections,
        excludedSections: defaultExcludedBuildSections(requestedSections),
      };
    });
    setAiResult(null);
    setAiError(null);
  }

  async function selectExampleDocuments() {
    setIsSelectingExampleDocuments(true);
    setAiError(null);
    try {
      const paths = await forge.selectExampleInputDocuments();
      if (paths.length === 0) {
        return;
      }
      const documents = await forge.summarizeExampleInputDocuments(paths);
      setAiForm((current) => ({
        ...current,
        exampleInputDocuments: [
          ...current.exampleInputDocuments,
          ...documents.map((document, index) => ({
            ...document,
            path: paths[index],
          })),
        ],
      }));
      setAiResult(null);
    } catch (caughtError) {
      setAiError(errorToMessage(caughtError));
    } finally {
      setIsSelectingExampleDocuments(false);
    }
  }

  function removeExampleDocument(index: number) {
    setAiForm((current) => ({
      ...current,
      exampleInputDocuments: current.exampleInputDocuments.filter((_, documentIndex) => documentIndex !== index),
    }));
    setAiResult(null);
  }

  async function loadEditKit(path: string) {
    setEditKitPath(path);
    setEditDraftLoad(null);
    setEditLoadError(null);
    setAiResult(null);
    setDraftChangeRequest("");
    if (!path) {
      return;
    }

    setIsLoadingEditDraft(true);
    try {
      const loadResult = await forge.loadAgentKitAsDraft(path);
      setEditDraftLoad(loadResult);
      const summary = summarizeAgentKitDraft(loadResult.draft);
      setAiForm((current) => ({
        ...current,
        userRequest: `Revise ${summary.name}`,
        domain: summary.domain === "Not specified" ? current.domain : summary.domain,
        targetUsers: summary.targetUsers === "Not specified" ? current.targetUsers : summary.targetUsers,
      }));
      const session: AgentKitDraftSession = {
        id: `edit-session-${Date.now()}`,
        name: summary.name,
        originalRequest: `Edit existing Agent Kit: ${summary.name}`,
        currentRevisionId: "revision-1",
        revisions: [
          {
            id: "revision-1",
            version: 1,
            draft: loadResult.draft,
            changeRequest: "Loaded existing kit",
            createdAt: new Date().toISOString(),
          },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {
          desiredValidationLevel: aiForm.desiredValidationLevel,
          sourceKitPath: path,
        },
      };
      setAiResult({
        draftJson: loadResult.draft,
        draftJsonPretty: `${JSON.stringify(loadResult.draft, null, 2)}\n`,
        warnings: loadResult.warnings,
        providerId: aiForm.providerId,
        providerName: getSelectedProvider(settings, aiForm.providerId)?.name ?? "Selected provider",
        model: aiForm.model,
        session,
        currentRevision: session.revisions[0],
      });
    } catch (caughtError) {
      setEditLoadError(errorToMessage(caughtError));
    } finally {
      setIsLoadingEditDraft(false);
    }
  }

  async function loadGuidedEditKit(path: string) {
    await loadEditKit(path);
    try {
      const loadResult = await forge.loadAgentKitAsDraft(path);
      setGuidedForm(guidedBuilderStateFromDraft(loadResult.draft, settings.defaultOutputFolder));
    } catch (caughtError) {
      setGuidedError(errorToMessage(caughtError));
    }
  }

  function updateGuidedForm<Key extends keyof GuidedBuilderState>(
    key: Key,
    value: GuidedBuilderState[Key],
  ) {
    setGuidedForm((current) => ({ ...current, [key]: value }));
    setGuidedError(null);
    setGuidedResult(null);
    setGuidedValidationReport(null);
  }

  function updateGuidedName(name: string) {
    setGuidedForm((current) => ({
      ...current,
      name,
      id: current.id.trim() === "" || current.id === slugify(current.name) ? slugify(name) : current.id,
      downloadFileName:
        current.downloadFileName.trim() === "" || current.downloadFileName === `${slugify(current.name)}-output`
          ? `${slugify(name)}-output`
          : current.downloadFileName,
    }));
  }

  function updateGuidedSkill(index: number, patch: Partial<GuidedSkill>) {
    setGuidedForm((current) => ({
      ...current,
      skills: current.skills.map((skill, skillIndex) => {
        if (skillIndex !== index) {
          return skill;
        }
        const next = { ...skill, ...patch };
        if (patch.name && (skill.id.trim() === "" || skill.id === slugify(skill.name))) {
          next.id = slugify(patch.name);
        }
        return next;
      }),
    }));
  }

  function addGuidedSkill() {
    setGuidedForm((current) => ({
      ...current,
      skills: [...current.skills, createDefaultGuidedSkill(current.skills.length + 1)],
    }));
  }

  function removeGuidedSkill(index: number) {
    setGuidedForm((current) => ({
      ...current,
      skills:
        current.skills.length > 1
          ? current.skills.filter((_, skillIndex) => skillIndex !== index)
          : current.skills,
    }));
  }

  function updateGuidedPolicy(index: number, text: string) {
    setGuidedForm((current) => ({
      ...current,
      guardrails: current.guardrails.map((guardrail, guardrailIndex) =>
        guardrailIndex === index ? { ...guardrail, text } : guardrail,
      ),
    }));
  }

  function addGuidedPolicy(text = "") {
    setGuidedForm((current) => ({
      ...current,
      guardrails: [
        ...current.guardrails,
        { id: `guardrail-${current.guardrails.length + 1}`, text },
      ],
    }));
  }

  function removeGuidedPolicy(index: number) {
    setGuidedForm((current) => ({
      ...current,
      guardrails: current.guardrails.filter((_, guardrailIndex) => guardrailIndex !== index),
    }));
  }

  function addDomainGuardrailPreset() {
    const presets = policyPresetsForDomain(guidedForm.domain);
    if (presets.length > 0) {
      setGuidedForm((current) => ({
        ...current,
        guardrails: [
          ...current.guardrails,
          ...presets.map((text, index) => ({
            id: `policy-${current.guardrails.length + index + 1}`,
            text,
          })),
        ],
      }));
    }
  }

  function updateGuidedPreparedPrompt(index: number, patch: Partial<GuidedPreparedPrompt>) {
    setGuidedForm((current) => ({
      ...current,
      preparedPrompts: current.preparedPrompts.map((prompt, promptIndex) => {
        if (promptIndex !== index) {
          return prompt;
        }
        const next = { ...prompt, ...patch };
        if (patch.name && (prompt.id.trim() === "" || prompt.id === slugify(prompt.name))) {
          next.id = slugify(patch.name);
        }
        return next;
      }),
    }));
  }

  function addGuidedPreparedPrompt() {
    setGuidedForm((current) => ({
      ...current,
      preparedPrompts: [
        ...current.preparedPrompts,
        createDefaultGuidedPrompt(current.preparedPrompts.length + 1),
      ],
    }));
  }

  function removeGuidedPreparedPrompt(index: number) {
    setGuidedForm((current) => ({
      ...current,
      preparedPrompts: current.preparedPrompts.filter((_, promptIndex) => promptIndex !== index),
    }));
  }

  function updateGuidedPromptInput(promptIndex: number, inputIndex: number, patch: Partial<GuidedRequiredInput>) {
    setGuidedForm((current) => ({
      ...current,
      preparedPrompts: current.preparedPrompts.map((prompt, currentPromptIndex) => {
        if (currentPromptIndex !== promptIndex) {
          return prompt;
        }
        return {
          ...prompt,
          inputs: prompt.inputs.map((input, currentInputIndex) => {
            if (currentInputIndex !== inputIndex) {
              return input;
            }
            const next = { ...input, ...patch };
            if (patch.label && (input.id.trim() === "" || input.id === promptInputId(input.label))) {
              next.id = promptInputId(patch.label);
            }
            return next;
          }),
        };
      }),
    }));
  }

  function addGuidedPromptInput(promptIndex: number, seed?: Partial<GuidedRequiredInput>) {
    setGuidedForm((current) => ({
      ...current,
      preparedPrompts: current.preparedPrompts.map((prompt, currentPromptIndex) =>
        currentPromptIndex === promptIndex
          ? {
              ...prompt,
              inputs: [
                ...prompt.inputs,
                { ...createDefaultRequiredInput(prompt.inputs.length + 1), ...seed },
              ],
            }
          : prompt,
      ),
    }));
  }

  function removeGuidedPromptInput(promptIndex: number, inputIndex: number) {
    setGuidedForm((current) => ({
      ...current,
      preparedPrompts: current.preparedPrompts.map((prompt, currentPromptIndex) =>
        currentPromptIndex === promptIndex
          ? { ...prompt, inputs: prompt.inputs.filter((_, currentInputIndex) => currentInputIndex !== inputIndex) }
          : prompt,
      ),
    }));
  }

  function updateGuidedExample(index: number, patch: Partial<GuidedExample>) {
    setGuidedForm((current) => ({
      ...current,
      examples: current.examples.map((example, exampleIndex) => {
        if (exampleIndex !== index) {
          return example;
        }
        const next = { ...example, ...patch };
        if (patch.prompt && (example.id.trim() === "" || example.id.startsWith("example-"))) {
          next.id = slugify(patch.prompt).slice(0, 40) || `example-${index + 1}`;
        }
        return next;
      }),
    }));
  }

  function addGuidedExample() {
    setGuidedForm((current) => ({
      ...current,
      examples: [...current.examples, createDefaultExample(current.examples.length + 1)],
    }));
  }

  function removeGuidedExample(index: number) {
    setGuidedForm((current) => ({
      ...current,
      examples: current.examples.filter((_, exampleIndex) => exampleIndex !== index),
    }));
  }

  async function selectGuidedOutputFolder() {
    setIsSelectingGuidedOutput(true);
    setGuidedError(null);

    try {
      const selectedPath = await forge.selectAgentKitFolder();
      if (selectedPath) {
        updateGuidedForm("outputFolder", selectedPath);
      }
    } catch (caughtError) {
      setGuidedError(errorToMessage(caughtError));
    } finally {
      setIsSelectingGuidedOutput(false);
    }
  }

  async function createGuidedKit(mode: "create" | "validate" | "validate-add") {
    const validationError = validateGuidedBuilder(guidedForm);
    setGuidedError(validationError);
    setGuidedResult(null);
    setGuidedValidationReport(null);

    if (validationError) {
      return;
    }

    setIsCreatingGuidedKit(true);

    try {
      const draft = buildGuidedAgentKitDraft(guidedForm);
      const result = await forge.renderGeneratedAgentKitDraft({
          draftJson: draft,
          outputFolder: guidedTargetOutputFolder(guidedForm),
          force: guidedForm.force,
        });
      setGuidedResult(result);
      onKitReady(result.rootPath);

      if (mode === "validate" || mode === "validate-add") {
        const report = await forge.validateAgentKit({
          rootPath: result.rootPath,
          profile: guidedDefaultValidationProfile(guidedForm),
        });
        setGuidedValidationReport(report);
      }
    } catch (caughtError) {
      setGuidedError(errorToMessage(caughtError));
    } finally {
      setIsCreatingGuidedKit(false);
    }
  }

  async function saveGuidedUpdate() {
    if (!editKitPath) {
      setGuidedError("Select an existing kit before saving an update.");
      return;
    }
    if (!window.confirm("This updates the selected Agent Kit files and may overwrite existing content. Use Save as new kit if you want to keep the original unchanged. Continue?")) {
      return;
    }
    const validationError = validateGuidedBuilder(guidedForm);
    setGuidedError(validationError);
    setGuidedResult(null);
    setGuidedValidationReport(null);
    if (validationError) {
      return;
    }
    setIsCreatingGuidedKit(true);
    try {
      const draft = buildGuidedAgentKitDraft(guidedForm);
      const result = await forge.renderGeneratedAgentKitDraft({
          draftJson: draft,
          outputFolder: editKitPath,
          force: true,
        });
      setGuidedResult(result);
      onKitReady(result.rootPath);
    } catch (caughtError) {
      setGuidedError(errorToMessage(caughtError));
    } finally {
      setIsCreatingGuidedKit(false);
    }
  }

  async function openGuidedFolder() {
    if (!guidedResult) {
      return;
    }
    try {
      await forge.openFolder(guidedResult.rootPath);
    } catch (caughtError) {
      setGuidedError(errorToMessage(caughtError));
    }
  }

  useEffect(() => {
    const provider = getSelectedProvider(settings, aiForm.providerId);
    setAiForm((current) => ({
      ...current,
      providerId: current.providerId || settings.defaultAiProviderId || "",
      model: current.model || provider?.model || provider?.defaultModel || settings.defaultModel || defaultRuntimeModel,
    }));
  }, [settings]);

  useEffect(() => {
    setForm((current) => ({ ...current, outputFolder: current.outputFolder || settings.defaultOutputFolder }));
    setDraftForm((current) => ({ ...current, outputFolder: current.outputFolder || settings.defaultOutputFolder }));
    setGeneratedRenderOutputFolder((current) => current || settings.defaultOutputFolder);
    setGuidedForm((current) => ({ ...current, outputFolder: current.outputFolder || settings.defaultOutputFolder }));
  }, [settings.defaultOutputFolder]);

  function updateForm<Key extends keyof CreateAgentKitInput>(
    key: Key,
    value: CreateAgentKitInput[Key],
  ) {
    setForm((current) => ({ ...current, [key]: value }));
    setResult(null);
    setError(null);
    setFieldErrors((current) => ({ ...current, [key]: undefined }));
  }

  async function selectOutputFolder() {
    setIsSelecting(true);
    setError(null);

    try {
      const selectedPath = await forge.selectAgentKitFolder();
      if (selectedPath) {
        updateForm("outputFolder", selectedPath);
      }
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    } finally {
      setIsSelecting(false);
    }
  }

  function updateDraftForm<Key extends keyof RenderAgentKitDraftInput>(
    key: Key,
    value: RenderAgentKitDraftInput[Key],
  ) {
    setDraftForm((current) => ({ ...current, [key]: value }));
    setDraftResult(null);
    setDraftError(null);
    setDraftFieldErrors((current) => ({ ...current, [key]: undefined }));
  }

  function updateAiForm<Key extends keyof GenerateAgentKitDraftInput>(
    key: Key,
    value: GenerateAgentKitDraftInput[Key],
  ) {
    setAiForm((current) => ({ ...current, [key]: value }));
    setAiResult(null);
    setAiError(null);
    setDraftCopyState("idle");
    setDraftSavePath(null);
    setGeneratedRenderResult(null);
    setGeneratedRenderError(null);
    setAiFieldErrors((current) => ({ ...current, [key]: undefined }));
  }

  async function selectDraftFile() {
    setIsSelectingDraftFile(true);
    setDraftError(null);

    try {
      const selectedPath = await forge.selectJsonFile();
      if (selectedPath) {
        updateDraftForm("draftFilePath", selectedPath);
      }
    } catch (caughtError) {
      setDraftError(errorToMessage(caughtError));
    } finally {
      setIsSelectingDraftFile(false);
    }
  }

  async function selectDraftOutputFolder() {
    setIsSelectingDraftOutput(true);
    setDraftError(null);

    try {
      const selectedPath = await forge.selectAgentKitFolder();
      if (selectedPath) {
        updateDraftForm("outputFolder", selectedPath);
      }
    } catch (caughtError) {
      setDraftError(errorToMessage(caughtError));
    } finally {
      setIsSelectingDraftOutput(false);
    }
  }

  async function createKit() {
    const validationErrors = validateCreateForm(form);
    setFieldErrors(validationErrors);
    setError(null);
    setResult(null);

    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setIsCreating(true);

    try {
      const createResult = await forge.createAgentKitFromTemplate(form);
      setResult(createResult);
      onKitReady(createResult.rootPath);
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    } finally {
      setIsCreating(false);
    }
  }

  async function renderDraft() {
    const validationErrors = validateDraftRenderForm(draftForm);
    setDraftFieldErrors(validationErrors);
    setDraftError(null);
    setDraftResult(null);

    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setIsRenderingDraft(true);

    try {
      const renderResult = await forge.renderAgentKitDraft(draftForm);
      setDraftResult(renderResult);
      onKitReady(renderResult.rootPath);
    } catch (caughtError) {
      setDraftError(errorToMessage(caughtError));
    } finally {
      setIsRenderingDraft(false);
    }
  }

  async function generateDraftWithOpenAI() {
    const validationErrors = validateGenerateDraftForm(settings, aiForm);
    setAiFieldErrors(validationErrors);
    setAiError(null);
    setAiResult(null);
    setDraftSavePath(null);
    setDraftCopyState("idle");
    setGeneratedRenderResult(null);
    setGeneratedRenderError(null);

    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setIsGeneratingDraft(true);

    try {
      const result = await forge.generateAgentKitDraftWithAi(aiForm);
      setAiResult(result);
      setDraftChangeRequest("");
    } catch (caughtError) {
      setAiError(errorToMessage(caughtError));
    } finally {
      setIsGeneratingDraft(false);
    }
  }

  async function requestDraftChanges() {
    if (!aiResult?.session) {
      setAiError("Generate an initial draft before requesting changes.");
      return;
    }

    if (!draftChangeRequest.trim()) {
      setAiError("Change request is required.");
      return;
    }

    setIsRevisingDraft(true);
    setAiError(null);
    setGeneratedRenderResult(null);
    setGeneratedRenderError(null);

    try {
      const input: ReviseAgentKitDraftInput = {
        session: aiResult.session,
        changeRequest: draftChangeRequest,
        desiredValidationLevel: aiForm.desiredValidationLevel,
        constraints: aiForm.constraints,
        sourceNotes: aiForm.sourceNotes,
        requestedSections: aiForm.requestedSections,
        excludedSections: aiForm.excludedSections,
        exampleInputDocuments: aiForm.exampleInputDocuments,
        providerId: aiForm.providerId,
        model: aiForm.model,
      };
      const result = await forge.reviseAgentKitDraftWithAi(input);
      setAiResult(result);
      setDraftChangeRequest("");
      setDraftCopyState("idle");
      setDraftSavePath(null);
    } catch (caughtError) {
      setAiError(errorToMessage(caughtError));
    } finally {
      setIsRevisingDraft(false);
    }
  }

  function restoreDraftRevision(revisionId: string) {
    if (!aiResult?.session) {
      return;
    }

    const revision = aiResult.session.revisions.find((entry) => entry.id === revisionId);
    if (!revision) {
      setAiError("Draft revision was not found.");
      return;
    }

    const session = {
      ...aiResult.session,
      currentRevisionId: revisionId,
      updatedAt: new Date().toISOString(),
    };
    setAiResult({
      ...aiResult,
      draftJson: revision.draft,
      draftJsonPretty: `${JSON.stringify(revision.draft, null, 2)}\n`,
      warnings: revision.warnings ?? [],
      providerName: revision.provider ?? aiResult.providerName,
      model: revision.model ?? aiResult.model,
      session,
      currentRevision: revision,
    });
    setAiError(null);
    setGeneratedRenderResult(null);
    setGeneratedRenderError(null);
  }

  function clearDraftSession() {
    setAiResult(null);
    setAiError(null);
    setDraftChangeRequest("");
    setDraftCopyState("idle");
    setDraftSavePath(null);
    setGeneratedRenderResult(null);
    setGeneratedRenderError(null);
  }

  async function copyGeneratedDraftJson() {
    if (!aiResult) {
      return;
    }

    try {
      await navigator.clipboard.writeText(aiResult.draftJsonPretty);
      setDraftCopyState("copied");
    } catch {
      setDraftCopyState("failed");
    }
  }

  async function saveGeneratedDraftJson() {
    if (!aiResult) {
      return;
    }

    setAiError(null);

    try {
      const outputPath = await forge.selectJsonOutputPath();
      if (!outputPath) {
        return;
      }

      const saveResult = await forge.saveAgentKitDraftJson({
        input: { draftJson: aiResult.draftJson },
        outputPath,
      });
      setDraftSavePath(saveResult.filePath);
    } catch (caughtError) {
      setAiError(errorToMessage(caughtError));
    }
  }

  async function selectGeneratedRenderOutputFolder() {
    setIsSelectingGeneratedRenderOutput(true);
    setGeneratedRenderError(null);

    try {
      const selectedPath = await forge.selectAgentKitFolder();
      if (selectedPath) {
        setGeneratedRenderOutputFolder(selectedPath);
        setGeneratedRenderResult(null);
      }
    } catch (caughtError) {
      setGeneratedRenderError(errorToMessage(caughtError));
    } finally {
      setIsSelectingGeneratedRenderOutput(false);
    }
  }

  async function renderGeneratedDraft() {
    if (!aiResult) {
      return;
    }

    if (generatedRenderOutputFolder.trim() === "") {
      setGeneratedRenderError("Output folder is required to render this draft.");
      return;
    }

    setIsRenderingGeneratedDraft(true);
    setGeneratedRenderError(null);
    setGeneratedRenderResult(null);

    try {
      const result = await forge.renderGeneratedAgentKitDraft({
          draftJson: aiResult.draftJson,
          outputFolder: generatedRenderOutputFolder,
          force: generatedRenderForce,
        });
      setGeneratedRenderResult(result);
    } catch (caughtError) {
      setGeneratedRenderError(errorToMessage(caughtError));
    } finally {
      setIsRenderingGeneratedDraft(false);
    }
  }

  async function saveEditUpdate() {
    if (!aiResult || !editKitPath) {
      setGeneratedRenderError("Select an existing kit before saving an update.");
      return;
    }
    if (!window.confirm("This updates the selected Agent Kit files and may overwrite existing content. Use Save as new kit if you want to keep the original unchanged. Continue?")) {
      return;
    }

    setIsRenderingGeneratedDraft(true);
    setGeneratedRenderError(null);
    setGeneratedRenderResult(null);

    try {
      const result = await forge.renderGeneratedAgentKitDraft({
          draftJson: aiResult.draftJson,
          outputFolder: editKitPath,
          force: true,
        });
      setGeneratedRenderResult(result);
      onKitReady(result.rootPath);
    } catch (caughtError) {
      setGeneratedRenderError(errorToMessage(caughtError));
    } finally {
      setIsRenderingGeneratedDraft(false);
    }
  }

  async function addRenderedKitToMyKits(rootPath: string) {
    try {
      await forge.addKitToLibrary({ path: rootPath, source: "built" });
      onKitReady(rootPath);
    } catch (caughtError) {
      setGeneratedRenderError(errorToMessage(caughtError));
      setGuidedError(errorToMessage(caughtError));
    }
  }

  const validationProfile = defaultValidationProfileForTemplate(result?.template ?? form.template);

  return (
    <div className="build-screen">
      <BuildModePicker
        activeGroup={activeBuildGroup}
        activeMode={activeBuildTab}
        onSelect={selectBuildTab}
        onSelectGroup={selectBuildGroup}
      />

      {activeBuildTab === "ai" && (
      <div className="build-layout">
        <div className="form-panel">
          <h2>Build with AI</h2>
          <div className="help-link-row">
            <button onClick={() => openDocsLink("https://forge.agentkitproject.com/docs/")} type="button">Build docs</button>
            <button onClick={() => openDocsLink("https://forge.agentkitproject.com/agent-kit-spec/")} type="button">Agent Kit Spec</button>
          </div>

          {settings.aiProviders.length === 0 && (
            <div className="inline-warning">Add an AI provider in Settings before generating drafts.</div>
          )}
          {selectedProviderSupportsStructuredJson(getSelectedProvider(settings, aiForm.providerId), aiForm.model) === false && (
            <div className="inline-warning">
              This provider may not reliably return valid AgentKitDraft JSON. AgentKitForge will
              validate the draft before rendering it.
            </div>
          )}

          <LabelWithHelp
            htmlFor="ai-user-request"
            label="Describe the Agent Kit you want"
            help="Tell AgentKitForge what this kit should help someone do. Plain language is best."
          />
          <textarea
            id="ai-user-request"
            onChange={(event) => updateAiForm("userRequest", event.target.value)}
            placeholder="Describe the Agent Kit's purpose, skills, workflows, and expected outputs."
            rows={5}
            value={aiForm.userRequest}
          />
          <FieldError message={aiFieldErrors.userRequest} />
          <FieldError message={aiFieldErrors.apiKey} />

          <LabelWithHelp
            htmlFor="ai-provider"
            label="AI provider"
            help="Choose the AI service or local model that will draft the kit."
          />
          <select
            id="ai-provider"
            onChange={(event) => {
              const provider = settings.aiProviders.find((item) => item.id === event.target.value);
              setAiForm((current) => ({
                ...current,
                providerId: event.target.value,
                model: provider?.model || provider?.defaultModel || current.model,
              }));
              setAiResult(null);
              setAiError(null);
            }}
            value={aiForm.providerId}
          >
            <option value="">Select provider</option>
            {settings.aiProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name} ({provider.providerType})
              </option>
            ))}
          </select>
          <FieldError message={aiFieldErrors.providerId} />

          <LabelWithHelp
            htmlFor="ai-domain"
            label="Domain"
            help="Pick the work area this kit belongs to. You can type your own if it is not listed."
          />
          <DomainSelector
            id="ai-domain"
            onChange={(value) => updateAiForm("domain", value)}
            value={aiForm.domain}
          />

          <LabelWithHelp
            htmlFor="ai-target-users"
            label="Target users"
            help="Who will use this kit, such as analysts, support agents, managers, or engineers."
          />
          <input
            id="ai-target-users"
            onChange={(event) => updateAiForm("targetUsers", event.target.value)}
            placeholder="Analysts, managers, operators"
            value={aiForm.targetUsers}
          />

          <LabelWithHelp
            htmlFor="ai-validation-level"
            label="Desired validation level"
            help="Higher levels ask for more complete kit materials. Start with local-valid while experimenting."
          />
          <select
            id="ai-validation-level"
            onChange={(event) =>
              updateAiForm("desiredValidationLevel", event.target.value as ValidationProfile)
            }
            value={aiForm.desiredValidationLevel}
          >
            {validationProfiles.map((profile) => (
              <option key={profile} value={profile}>
                {profile}
              </option>
            ))}
          </select>
          <FieldError message={aiFieldErrors.desiredValidationLevel} />

          <label htmlFor="ai-constraints">Constraints</label>
          <textarea
            id="ai-constraints"
            onChange={(event) => updateAiForm("constraints", event.target.value)}
            placeholder="Optional constraints, one per line or comma-separated."
            rows={3}
            value={aiForm.constraints}
          />

          <label htmlFor="ai-source-notes">Source notes</label>
          <textarea
            id="ai-source-notes"
            onChange={(event) => updateAiForm("sourceNotes", event.target.value)}
            placeholder="Optional notes to ground the generated draft."
            rows={3}
            value={aiForm.sourceNotes}
          />

          <BuildSectionSelector
            selectedSections={aiForm.requestedSections}
            onToggle={updateBuildSections}
          />

          <ExampleInputDocumentsPanel
            documents={aiForm.exampleInputDocuments}
            isSelecting={isSelectingExampleDocuments}
            onRemove={removeExampleDocument}
            onSelect={selectExampleDocuments}
          />

          <LabelWithHelp
            htmlFor="ai-model"
            label="Model"
            help="Use a suggested model or type a custom model ID from your provider."
          />
          <ModelInput
            id="ai-model"
            model={aiForm.model}
            onModelChange={(value) => updateAiForm("model", value)}
            providerType={getSelectedProvider(settings, aiForm.providerId)?.providerType}
          />

          <button
            className="primary-button"
            disabled={isGeneratingDraft}
            onClick={generateDraftWithOpenAI}
            type="button"
          >
            <Sparkles size={18} />
            {isGeneratingDraft && <InlineSpinner className="button-spinner" />}
            {isGeneratingDraft ? "Generating" : "Generate Draft"}
          </button>
          {isGeneratingDraft && <LoadingStatus text="Asking provider to build the first draft..." />}
        </div>

        <div className="results-panel">
          <div className="panel-label">Generated Draft</div>
          <GeneratedDraftResults
            copyState={draftCopyState}
            changeRequest={draftChangeRequest}
            error={aiError}
            isLoading={isGeneratingDraft}
            isRevising={isRevisingDraft}
            onChangeRequestChange={setDraftChangeRequest}
            onClearSession={clearDraftSession}
            onCopyJson={copyGeneratedDraftJson}
            onRenderDraft={renderGeneratedDraft}
            onRequestChanges={requestDraftChanges}
            onSaveJson={saveGeneratedDraftJson}
            onRestoreRevision={restoreDraftRevision}
            result={aiResult}
            savePath={draftSavePath}
            renderOutputFolder={generatedRenderOutputFolder}
            onRenderOutputFolderChange={(value) => {
              setGeneratedRenderOutputFolder(value);
              setGeneratedRenderError(null);
              setGeneratedRenderResult(null);
            }}
            onSelectRenderOutputFolder={selectGeneratedRenderOutputFolder}
            renderForce={generatedRenderForce}
            onRenderForceChange={setGeneratedRenderForce}
            renderError={generatedRenderError}
            renderResult={generatedRenderResult}
            isSelectingRenderOutput={isSelectingGeneratedRenderOutput}
            isRenderingDraft={isRenderingGeneratedDraft}
            onValidateRenderedKit={(rootPath) => onValidateCreatedKit(rootPath, "local-valid")}
            onAddToMyKits={addRenderedKitToMyKits}
            onPackageKit={onPackageKit}
            onUseKit={onUseKit}
            saveLabel="Save"
          />
        </div>
      </div>
      )}

      {activeBuildTab === "edit-ai" && (
        <div className="build-layout">
          <div className="form-panel">
            <h2>Edit with AI</h2>
            <p className="form-copy">Load an existing kit from My Kits, ask for changes, then save the updated draft when ready.</p>
            <MyKitSelector
              currentKitPath={editKitPath}
              kits={myKitsForBuild}
              label="Agent Kit"
              onChange={loadEditKit}
            />
            {isLoadingEditDraft && <LoadingStatus text="Loading selected kit as an editable draft..." />}
            {editLoadError && <div className="error-state" role="alert">{editLoadError}</div>}
            {editDraftLoad && (
              <>
                <AIDraftSummary
                  summary={summarizeAgentKitDraft(editDraftLoad.draft)}
                  validationTarget={aiForm.desiredValidationLevel}
                />
                {editDraftLoad.warnings.length > 0 && (
                  <div className="inline-warning">
                    {editDraftLoad.warnings.map((warning) => <div key={warning}>{warning}</div>)}
                  </div>
                )}
              </>
            )}

            <LabelWithHelp
              htmlFor="edit-ai-provider"
              label="AI provider"
              help="Choose the AI service or local model that will revise the kit."
            />
            <select
              id="edit-ai-provider"
              onChange={(event) => {
                const provider = settings.aiProviders.find((item) => item.id === event.target.value);
                setAiForm((current) => ({
                  ...current,
                  providerId: event.target.value,
                  model: provider?.model || provider?.defaultModel || current.model,
                }));
              }}
              value={aiForm.providerId}
            >
              <option value="">Select provider</option>
              {settings.aiProviders.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name} ({provider.providerType})
                </option>
              ))}
            </select>
            <ModelInput
              id="edit-ai-model"
              model={aiForm.model}
              onModelChange={(value) => updateAiForm("model", value)}
              providerType={getSelectedProvider(settings, aiForm.providerId)?.providerType}
            />
            <BuildSectionSelector selectedSections={aiForm.requestedSections} onToggle={updateBuildSections} />
            <ExampleInputDocumentsPanel
              documents={aiForm.exampleInputDocuments}
              isSelecting={isSelectingExampleDocuments}
              onRemove={removeExampleDocument}
              onSelect={selectExampleDocuments}
            />
          </div>
          <div className="results-panel">
            <div className="panel-label">AI Draft Session</div>
            <GeneratedDraftResults
              copyState={draftCopyState}
              changeRequest={draftChangeRequest}
              error={aiError}
              isLoading={isGeneratingDraft}
              isRevising={isRevisingDraft}
              onChangeRequestChange={setDraftChangeRequest}
              onClearSession={clearDraftSession}
              onCopyJson={copyGeneratedDraftJson}
              onRenderDraft={renderGeneratedDraft}
              onRequestChanges={requestDraftChanges}
              onSaveJson={saveGeneratedDraftJson}
              onRestoreRevision={restoreDraftRevision}
              result={aiResult}
              savePath={draftSavePath}
              renderOutputFolder={generatedRenderOutputFolder}
              onRenderOutputFolderChange={(value) => {
                setGeneratedRenderOutputFolder(value);
                setGeneratedRenderError(null);
                setGeneratedRenderResult(null);
              }}
              onSelectRenderOutputFolder={selectGeneratedRenderOutputFolder}
              renderForce={generatedRenderForce}
              onRenderForceChange={setGeneratedRenderForce}
              renderError={generatedRenderError}
              renderResult={generatedRenderResult}
              isSelectingRenderOutput={isSelectingGeneratedRenderOutput}
              isRenderingDraft={isRenderingGeneratedDraft}
              onValidateRenderedKit={(rootPath) => onValidateCreatedKit(rootPath, "local-valid")}
              onAddToMyKits={addRenderedKitToMyKits}
              onPackageKit={onPackageKit}
              onUseKit={onUseKit}
              onSaveUpdate={saveEditUpdate}
              saveLabel="Save as new kit"
              updateLabel="Save update"
            />
          </div>
        </div>
      )}

      {activeBuildTab === "guided-edit" && (
        <div className="build-layout">
          <div className="form-panel">
            <h2>Guided Editor</h2>
            <p className="form-copy">Choose a kit from My Kits, load it into the Guided Builder, then save changes.</p>
            <MyKitSelector
              currentKitPath={editKitPath}
              kits={myKitsForBuild}
              label="Agent Kit"
              onChange={loadGuidedEditKit}
            />
            {isLoadingEditDraft && <LoadingStatus text="Loading selected kit as an editable draft..." />}
            {editLoadError && <div className="error-state" role="alert">{editLoadError}</div>}
            {editDraftLoad && (
              <div className="inline-warning">
                Save update rewrites files for the selected kit. Use Save as new kit if you want to keep the original unchanged.
              </div>
            )}
            <button
              className="primary-button"
              disabled={!editKitPath || isCreatingGuidedKit}
              onClick={saveGuidedUpdate}
              type="button"
            >
              {isCreatingGuidedKit && <InlineSpinner className="button-spinner" />}
              {isCreatingGuidedKit ? "Saving" : "Save update"}
            </button>
          </div>
          <GuidedBuilder
            error={guidedError}
            form={guidedForm}
            isCreating={isCreatingGuidedKit}
            isSelectingOutput={isSelectingGuidedOutput}
            onAddExample={addGuidedExample}
            onAddPolicy={() => addGuidedPolicy()}
            onAddPrompt={addGuidedPreparedPrompt}
            onAddPromptInput={addGuidedPromptInput}
            onAddSkill={addGuidedSkill}
            onApplyPreset={addDomainGuardrailPreset}
            onCreate={createGuidedKit}
            onOpenFolder={openGuidedFolder}
            onPackageKit={onPackageKit}
            onRemoveExample={removeGuidedExample}
            onRemovePolicy={removeGuidedPolicy}
            onRemovePrompt={removeGuidedPreparedPrompt}
            onRemovePromptInput={removeGuidedPromptInput}
            onRemoveSkill={removeGuidedSkill}
            onSelectOutput={selectGuidedOutputFolder}
            onStepChange={setGuidedStep}
            onUpdate={updateGuidedForm}
            onUpdateExample={updateGuidedExample}
            onUpdatePolicy={updateGuidedPolicy}
            onUpdatePrompt={updateGuidedPreparedPrompt}
            onUpdatePromptInput={updateGuidedPromptInput}
            onUpdateName={updateGuidedName}
            onUpdateSkill={updateGuidedSkill}
            onUseKit={onUseKit}
            onValidateKit={(rootPath) => onValidateCreatedKit(rootPath, guidedDefaultValidationProfile(guidedForm))}
            result={guidedResult}
            step={guidedStep}
            validationReport={guidedValidationReport}
          />
        </div>
      )}

      {activeBuildTab === "guided" && (
        <GuidedBuilder
          error={guidedError}
          form={guidedForm}
          isCreating={isCreatingGuidedKit}
          isSelectingOutput={isSelectingGuidedOutput}
          onAddExample={addGuidedExample}
          onAddPolicy={() => addGuidedPolicy()}
          onAddPrompt={addGuidedPreparedPrompt}
          onAddPromptInput={addGuidedPromptInput}
          onAddSkill={addGuidedSkill}
          onApplyPreset={addDomainGuardrailPreset}
          onCreate={createGuidedKit}
          onOpenFolder={openGuidedFolder}
          onPackageKit={onPackageKit}
          onRemoveExample={removeGuidedExample}
          onRemovePolicy={removeGuidedPolicy}
          onRemovePrompt={removeGuidedPreparedPrompt}
          onRemovePromptInput={removeGuidedPromptInput}
          onRemoveSkill={removeGuidedSkill}
          onSelectOutput={selectGuidedOutputFolder}
          onStepChange={setGuidedStep}
          onUpdate={updateGuidedForm}
          onUpdateExample={updateGuidedExample}
          onUpdatePolicy={updateGuidedPolicy}
          onUpdatePrompt={updateGuidedPreparedPrompt}
          onUpdatePromptInput={updateGuidedPromptInput}
          onUpdateName={updateGuidedName}
          onUpdateSkill={updateGuidedSkill}
          onUseKit={onUseKit}
          onValidateKit={(rootPath) => onValidateCreatedKit(rootPath, guidedDefaultValidationProfile(guidedForm))}
          result={guidedResult}
          step={guidedStep}
          validationReport={guidedValidationReport}
        />
      )}

      {activeBuildTab === "template" && (
      <div className="build-layout">
        <div className="form-panel">
          <h2>Create from template</h2>

        <LabelWithHelp
          htmlFor="build-output-folder"
          label="Save location"
          help="New kits are saved in your AgentKitForge Kits folder by default. You can choose a different folder."
        />
        <div className="path-picker">
          <input
            id="build-output-folder"
            onChange={(event) => updateForm("outputFolder", event.target.value)}
            placeholder="Documents/AgentKitForge/Kits"
            value={form.outputFolder}
          />
          <button
            className="icon-button"
            disabled={isSelecting || isCreating}
            onClick={selectOutputFolder}
            title="Select output folder"
            type="button"
          >
            <FolderOpen size={18} />
          </button>
        </div>
        <FieldError message={fieldErrors.outputFolder} />

        <label htmlFor="build-kit-id">Kit id</label>
        <input
          id="build-kit-id"
          onChange={(event) => updateForm("id", event.target.value)}
          placeholder="customer-support"
          value={form.id}
        />
        <FieldError message={fieldErrors.id} />

        <label htmlFor="build-kit-name">Kit name</label>
        <input
          id="build-kit-name"
          onChange={(event) => updateForm("name", event.target.value)}
          placeholder="Customer Support"
          value={form.name}
        />
        <FieldError message={fieldErrors.name} />

        <label htmlFor="build-kit-description">Kit description</label>
        <textarea
          id="build-kit-description"
          onChange={(event) => updateForm("description", event.target.value)}
          placeholder="A kit for handling customer support workflows."
          rows={4}
          value={form.description}
        />
        <FieldError message={fieldErrors.description} />

        <label htmlFor="build-template">Template</label>
        <select
          id="build-template"
          onChange={(event) => updateForm("template", event.target.value as AgentKitTemplate)}
          value={form.template}
        >
          {agentKitTemplates.map((template) => (
            <option key={template} value={template}>
              {template}
            </option>
          ))}
        </select>
        <FieldError message={fieldErrors.template} />

        <label className="checkbox-row" htmlFor="build-force">
          <input
            checked={form.force}
            id="build-force"
            onChange={(event) => updateForm("force", event.target.checked)}
            type="checkbox"
          />
          <span>Force overwrite template files</span>
          <HelpTip text="Use this only when you intentionally want generated files to replace files in the same kit folder." />
        </label>

        <button className="primary-button" disabled={isCreating} onClick={createKit} type="button">
          <Box size={18} />
          {isCreating && <InlineSpinner className="button-spinner" />}
          {isCreating ? "Creating" : "Create"}
        </button>
        </div>

        <div className="results-panel">
          <div className="panel-label">Create Result</div>
          <CreateAgentKitResults
            error={error}
            isLoading={isCreating}
            onValidateCreatedKit={(rootPath) => onValidateCreatedKit(rootPath, validationProfile)}
            result={result}
            validationProfile={validationProfile}
          />
        </div>
      </div>
      )}

      {activeBuildTab === "draft" && (
      <div className="build-layout">
        <div className="form-panel">
          <h2>Render from Draft JSON</h2>

          <label htmlFor="draft-json-file">Draft JSON file</label>
          <div className="path-picker">
            <input
              id="draft-json-file"
              onChange={(event) => updateDraftForm("draftFilePath", event.target.value)}
              placeholder="Documents/AgentKitForge/Drafts/agent-kit-draft.json"
              value={draftForm.draftFilePath}
            />
            <button
              className="icon-button"
              disabled={isSelectingDraftFile || isRenderingDraft}
              onClick={selectDraftFile}
              title="Select draft JSON"
              type="button"
            >
              <FileArchive size={18} />
            </button>
          </div>
          <FieldError message={draftFieldErrors.draftFilePath} />

          <LabelWithHelp
            htmlFor="draft-output-folder"
            label="Save location"
            help="The rendered kit will be written to this folder and can be added to My Kits."
          />
          <div className="path-picker">
            <input
              id="draft-output-folder"
              onChange={(event) => updateDraftForm("outputFolder", event.target.value)}
              placeholder="Documents/AgentKitForge/Kits/rendered-agent-kit"
              value={draftForm.outputFolder}
            />
            <button
              className="icon-button"
              disabled={isSelectingDraftOutput || isRenderingDraft}
              onClick={selectDraftOutputFolder}
              title="Select output folder"
              type="button"
            >
              <FolderOpen size={18} />
            </button>
          </div>
          <FieldError message={draftFieldErrors.outputFolder} />

          <label className="checkbox-row" htmlFor="draft-force">
            <input
              checked={draftForm.force}
              id="draft-force"
              onChange={(event) => updateDraftForm("force", event.target.checked)}
              type="checkbox"
            />
            <span>Force overwrite generated files</span>
            <HelpTip text="Use this only when you intentionally want generated files to replace existing files." />
          </label>

          <button
            className="primary-button"
            disabled={isRenderingDraft}
            onClick={renderDraft}
            type="button"
          >
            <FileArchive size={18} />
            {isRenderingDraft && <InlineSpinner className="button-spinner" />}
            {isRenderingDraft ? "Rendering" : "Render"}
          </button>
        </div>

        <div className="results-panel">
          <div className="panel-label">Render Result</div>
          <RenderAgentKitDraftResults
            error={draftError}
            isLoading={isRenderingDraft}
            onValidateRenderedKit={(rootPath) => onValidateCreatedKit(rootPath, "local-valid")}
            result={draftResult}
          />
        </div>
      </div>
      )}

    </div>
  );
}

function BuildModePicker({
  activeGroup,
  activeMode,
  onSelect,
  onSelectGroup,
}: {
  activeGroup: BuildModeGroup;
  activeMode: BuildTabId;
  onSelect: (mode: BuildTabId) => void;
  onSelectGroup: (group: BuildModeGroup) => void;
}) {
  const visibleModes = buildModes.filter((mode) => mode.group === activeGroup);

  return (
    <div className="build-mode-groups">
      <div className="segmented-control" role="tablist" aria-label="Build workspace">
        {(["Create New", "Edit Existing"] as const).map((group) => (
          <button
            aria-selected={activeGroup === group}
            className={`segment-button ${activeGroup === group ? "active" : ""}`}
            key={group}
            onClick={() => onSelectGroup(group)}
            role="tab"
            type="button"
          >
            {group}
          </button>
        ))}
      </div>
      <section className="build-mode-group">
        <div className="build-mode-grid">
          {visibleModes.map((mode) => {
            const Icon = mode.icon;
            return (
              <button
                aria-selected={activeMode === mode.id}
                className={`build-mode-card ${activeMode === mode.id ? "active" : ""}`}
                key={mode.id}
                onClick={() => onSelect(mode.id)}
                type="button"
              >
                <Icon size={22} />
                <span>
                  <strong>
                    {mode.title}
                    <HelpTip focusable={false} text={mode.description} />
                  </strong>
                  <small>{mode.description}</small>
                  <em>{mode.bestFor}</em>
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function BuildSectionSelector({
  selectedSections,
  onToggle,
}: {
  selectedSections: string[];
  onToggle: (sectionId: string, selected: boolean) => void;
}) {
  return (
    <div className="section-selector">
      <div className="section-selector-header">
        <LabelWithHelp
          htmlFor="build-section-selector"
          label="Sections to include"
          help="Basics and Skills are required. Prepared Prompts are recommended, and other sections are optional."
        />
      </div>
      <div className="section-chip-grid">
        {buildSectionOptions.map((section) => {
          const selected = selectedSections.includes(section.id);
          return (
            <label className={`section-chip ${selected ? "selected" : ""}`} key={section.id}>
              <input
                checked={selected}
                disabled={section.required}
                onChange={(event) => onToggle(section.id, event.target.checked)}
                type="checkbox"
              />
              <span>
                {section.label}
                {section.required && <em>Required</em>}
                {section.recommended && <em>Recommended</em>}
                {section.advanced && <em>Advanced</em>}
                <small>{section.help}</small>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function ExampleInputDocumentsPanel({
  documents,
  isSelecting,
  onRemove,
  onSelect,
}: {
  documents: ExampleInputDocument[];
  isSelecting: boolean;
  onRemove: (index: number) => void;
  onSelect: () => void;
}) {
  return (
    <div className="section-selector">
      <div className="friendly-location-row">
        <LabelWithHelp
          htmlFor="example-input-documents"
          label="Example input document"
          help="Optional. Add a sample document, CSV, or spreadsheet so the AI can match expected formatting, terminology, and output style."
        />
        <button className="secondary-button compact-button" disabled={isSelecting} onClick={onSelect} type="button">
          <FileArchive size={18} />
          {isSelecting ? "Selecting" : "Attach document"}
        </button>
      </div>
      {documents.length > 0 && (
        <div className="artifact-list">
          {documents.map((document, index) => (
            <article className="artifact-item" key={`${document.filename}-${index}`}>
              <div>
                <div className="issue-code">{document.filename}</div>
                <p>{document.kind}{document.notes ? ` - ${document.notes}` : ""}</p>
                {document.path && (
                  <details className="advanced-details compact-advanced">
                    <summary>Show full path</summary>
                    <div>{document.path}</div>
                  </details>
                )}
              </div>
              <button className="secondary-button compact-button" onClick={() => onRemove(index)} type="button">
                Remove
              </button>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function MyKitSelector({
  currentKitPath,
  kits,
  label,
  onChange,
}: {
  currentKitPath: string;
  kits: MyKitEntry[];
  label: string;
  onChange: (path: string) => void;
}) {
  return (
    <>
      <LabelWithHelp htmlFor="my-kit-selector" label={label} help="Choose a kit from My Kits. Import a kit first if it is not listed." />
      <select id="my-kit-selector" onChange={(event) => onChange(event.target.value)} value={currentKitPath}>
        <option value="">Select from My Kits</option>
        {kits.filter((kit) => kit.pathExists).map((kit) => (
          <option key={kit.path} value={kit.path}>
            {kit.name} ({formatDisplayVersion(kit.version)})
          </option>
        ))}
      </select>
      {kits.length === 0 && <p className="state-copy compact-state">No kits in My Kits yet. Build or import one first.</p>}
    </>
  );
}

function SelectedKitSummaryCard({ kit }: { kit: MyKitEntry }) {
  return (
    <article className="selected-kit-card">
      <div>
        <strong>{kit.name}</strong>
        <span>{formatDisplayVersion(kit.version)}</span>
      </div>
      <p>{kit.description || "No description available."}</p>
      <small>{friendlyLocation(kit.path)}</small>
      <details className="advanced-details compact-advanced">
        <summary>Show full path</summary>
        <div className="inline-code">{kit.path}</div>
      </details>
    </article>
  );
}

function GuidedBuilder({
  error,
  form,
  isCreating,
  isSelectingOutput,
  onAddExample,
  onAddPolicy,
  onAddPrompt,
  onAddPromptInput,
  onAddSkill,
  onApplyPreset,
  onCreate,
  onOpenFolder,
  onPackageKit,
  onRemoveExample,
  onRemovePolicy,
  onRemovePrompt,
  onRemovePromptInput,
  onRemoveSkill,
  onSelectOutput,
  onStepChange,
  onUpdate,
  onUpdateExample,
  onUpdatePolicy,
  onUpdatePrompt,
  onUpdatePromptInput,
  onUpdateName,
  onUpdateSkill,
  onUseKit,
  onValidateKit,
  result,
  step,
  validationReport,
}: {
  error: string | null;
  form: GuidedBuilderState;
  isCreating: boolean;
  isSelectingOutput: boolean;
  onAddExample: () => void;
  onAddPolicy: () => void;
  onAddPrompt: () => void;
  onAddPromptInput: (promptIndex: number, seed?: Partial<GuidedRequiredInput>) => void;
  onAddSkill: () => void;
  onApplyPreset: () => void;
  onCreate: (mode: "create" | "validate" | "validate-add") => void;
  onOpenFolder: () => void;
  onPackageKit: (rootPath: string) => void;
  onRemoveExample: (index: number) => void;
  onRemovePolicy: (index: number) => void;
  onRemovePrompt: (index: number) => void;
  onRemovePromptInput: (promptIndex: number, inputIndex: number) => void;
  onRemoveSkill: (index: number) => void;
  onSelectOutput: () => void;
  onStepChange: (step: GuidedBuilderStep) => void;
  onUpdate: <Key extends keyof GuidedBuilderState>(key: Key, value: GuidedBuilderState[Key]) => void;
  onUpdateExample: (index: number, patch: Partial<GuidedExample>) => void;
  onUpdatePolicy: (index: number, text: string) => void;
  onUpdatePrompt: (index: number, patch: Partial<GuidedPreparedPrompt>) => void;
  onUpdatePromptInput: (promptIndex: number, inputIndex: number, patch: Partial<GuidedRequiredInput>) => void;
  onUpdateName: (name: string) => void;
  onUpdateSkill: (index: number, patch: Partial<GuidedSkill>) => void;
  onUseKit: (rootPath: string) => void;
  onValidateKit: (rootPath: string) => void;
  result: RenderAgentKitDraftResult | null;
  step: GuidedBuilderStep;
  validationReport: ValidationReport | null;
}) {
  const stepIndex = guidedSteps.findIndex((item) => item.id === step);
  const canGoBack = stepIndex > 0;
  const canGoForward = stepIndex < guidedSteps.length - 1;

  return (
    <div className="guided-builder">
      <div className="guided-stepper" aria-label="Guided Builder steps">
        {guidedSteps.map((item, index) => (
          <button
            className={`step-button ${item.id === step ? "active" : ""}`}
            key={item.id}
            onClick={() => onStepChange(item.id)}
            type="button"
          >
            <span className="step-index">{index + 1}</span>
            <span className="step-label">
              {item.label}
              {item.badge && <em className={`step-badge ${item.badge.toLowerCase()}`}>{item.badge}</em>}
            </span>
          </button>
        ))}
      </div>

      <div className="build-layout">
        <div className="form-panel guided-builder-panel">
          <div className="guided-requirements-summary">
            <strong>Required:</strong> Basics and at least one Skill.
            <span>Recommended: Prepared Prompts for repeatable tasks.</span>
            <span>Optional: Policies, Templates, Examples, Workflows, References, Evals, and Scripts.</span>
          </div>

          {step === "basics" && (
            <>
              <h2>Basics</h2>
              <LabelWithHelp htmlFor="guided-name" label="Kit name" help="Use a friendly name people will recognize." />
              <input id="guided-name" onChange={(event) => onUpdateName(event.target.value)} placeholder="Quarterly Board Reporting Assistant" value={form.name} />

              <details className="advanced-details">
                <summary>Advanced: Kit ID</summary>
                <LabelWithHelp htmlFor="guided-id" label="Kit ID" help="This becomes the folder-friendly kit identifier. Lowercase letters, numbers, and hyphens work best." />
                <input id="guided-id" onChange={(event) => onUpdate("id", slugify(event.target.value))} value={form.id} />
              </details>

              <LabelWithHelp htmlFor="guided-description" label="Description" help="A short explanation of what this kit helps users do." />
              <textarea id="guided-description" onChange={(event) => onUpdate("description", event.target.value)} rows={4} value={form.description} />

              <LabelWithHelp htmlFor="guided-domain" label="Domain" help="Pick the closest work area, or type a custom domain." />
              <DomainSelector id="guided-domain" onChange={(value) => onUpdate("domain", value)} value={form.domain} />

              <LabelWithHelp htmlFor="guided-target-users" label="Target users" help="Who will use the kit?" />
              <input id="guided-target-users" onChange={(event) => onUpdate("targetUsers", event.target.value)} placeholder="Analysts, operators, managers..." value={form.targetUsers} />

              <LabelWithHelp htmlFor="guided-validation" label="Desired validation level" help="Trusted is best when you include guardrails and examples." />
              <select id="guided-validation" onChange={(event) => onUpdate("validationLevel", event.target.value as ValidationProfile)} value={form.validationLevel}>
                {validationProfiles.map((profile) => <option key={profile} value={profile}>{profile}</option>)}
              </select>

              <LabelWithHelp htmlFor="guided-output-folder" label="Save location" help="Defaults to your AgentKitForge Kits folder. You can choose another folder." />
              <div className="friendly-location-row">
                <span>Save to: {form.outputFolder ? "AgentKitForge Library" : "Choose a save location"}</span>
                <button className="secondary-button compact-button" disabled={isSelectingOutput || isCreating} onClick={onSelectOutput} type="button">
                  Change location
                </button>
              </div>
              <details className="advanced-details">
                <summary>Advanced: Show folder path</summary>
                <div className="path-picker">
                  <input id="guided-output-folder" onChange={(event) => onUpdate("outputFolder", event.target.value)} value={form.outputFolder} />
                  <button className="icon-button" disabled={isSelectingOutput || isCreating} onClick={onSelectOutput} title="Select save location" type="button">
                    <FolderOpen size={18} />
                  </button>
                </div>
              </details>
            </>
          )}

          {step === "skills" && (
            <>
              <div className="panel-heading">
                <h2>Skills</h2>
                <button className="secondary-button compact-button" onClick={onAddSkill} type="button">Add skill</button>
              </div>
              {form.skills.map((skill, index) => (
                <article className="guided-card" key={`${skill.id}-${index}`}>
                  <div className="panel-heading">
                    <h3>Skill {index + 1}</h3>
                    <button className="secondary-button compact-button" disabled={form.skills.length === 1} onClick={() => onRemoveSkill(index)} type="button">Remove</button>
                  </div>
                  <LabelWithHelp htmlFor={`skill-name-${index}`} label="Skill name" help="Name one repeatable thing the kit can do." />
                  <input id={`skill-name-${index}`} onChange={(event) => onUpdateSkill(index, { name: event.target.value })} value={skill.name} />
                  <details className="advanced-details">
                    <summary>Advanced: Skill ID</summary>
                    <input onChange={(event) => onUpdateSkill(index, { id: slugify(event.target.value) })} value={skill.id} />
                  </details>
                  <label>Description</label>
                  <input onChange={(event) => onUpdateSkill(index, { description: event.target.value })} value={skill.description} />
                  <label>Trigger phrases</label>
                  <textarea onChange={(event) => onUpdateSkill(index, { triggers: event.target.value })} placeholder="One per line, such as review workbook or summarize risks" rows={3} value={skill.triggers} />
                  <label>Use when</label>
                  <textarea onChange={(event) => onUpdateSkill(index, { useWhen: event.target.value })} rows={3} value={skill.useWhen} />
                  <label>Do not use when</label>
                  <textarea onChange={(event) => onUpdateSkill(index, { doNotUseWhen: event.target.value })} rows={2} value={skill.doNotUseWhen} />
                  <label>Inputs</label>
                  <textarea onChange={(event) => onUpdateSkill(index, { inputs: event.target.value })} rows={2} value={skill.inputs} />
                  <label>Procedure steps</label>
                  <textarea onChange={(event) => onUpdateSkill(index, { procedure: event.target.value })} rows={5} value={skill.procedure} />
                  <label>Output expectations</label>
                  <textarea onChange={(event) => onUpdateSkill(index, { output: event.target.value })} rows={3} value={skill.output} />
                  <label>Risk level</label>
                  <select onChange={(event) => onUpdateSkill(index, { riskLevel: event.target.value })} value={skill.riskLevel}>
                    {["low", "medium", "high"].map((risk) => <option key={risk} value={risk}>{risk}</option>)}
                  </select>
                </article>
              ))}
            </>
          )}

          {step === "policies" && (
            <>
              <div className="panel-heading">
                <h2>Policies <span className="metadata-pill">Optional</span></h2>
                <div className="button-row">
                  <button className="secondary-button compact-button" onClick={onApplyPreset} type="button">Add domain preset</button>
                  <button className="secondary-button compact-button" onClick={onAddPolicy} type="button">Add policy</button>
                </div>
              </div>
              <p className="form-copy">Policies are guardrails that tell the AI what to avoid, require, or escalate.</p>
              <p className="form-copy">This step is optional. You can skip it and still create a valid Agent Kit.</p>
              {isRiskyGuidedDomain(form.domain) && form.guardrails.length === 0 && (
                <div className="inline-warning">This domain often benefits from policies. Add a preset or custom policy before sharing the kit.</div>
              )}
              {form.guardrails.length === 0 && <p className="state-copy">You can skip this step and create the kit without policies.</p>}
              {form.guardrails.map((guardrail, index) => (
                <div className="guided-list-row" key={`${guardrail.id}-${index}`}>
                  <textarea onChange={(event) => onUpdatePolicy(index, event.target.value)} rows={2} value={guardrail.text} />
                  <button className="secondary-button compact-button" onClick={() => onRemovePolicy(index)} type="button">Remove</button>
                </div>
              ))}
            </>
          )}

          {step === "outputs" && (
            <>
              <h2>Outputs / Templates <span className="metadata-pill">Optional</span></h2>
              <p className="form-copy">This step is optional. You can skip it and still create a valid Agent Kit.</p>
              <LabelWithHelp htmlFor="guided-output-sections" label="Expected output sections" help="List the sections users should usually receive." />
              <textarea id="guided-output-sections" onChange={(event) => onUpdate("outputSections", event.target.value)} rows={4} value={form.outputSections} />
              <label>Optional output template</label>
              <textarea onChange={(event) => onUpdate("outputTemplate", event.target.value)} rows={6} value={form.outputTemplate} />
              <label className="checkbox-row">
                <input checked={form.documentLike} onChange={(event) => onUpdate("documentLike", event.target.checked)} type="checkbox" />
                <span>Result is document-like</span>
              </label>
              <label>Suggested downloadable output name</label>
              <input onChange={(event) => onUpdate("downloadFileName", event.target.value)} value={form.downloadFileName} />
              <label>Client/user-facing summary style</label>
              <input onChange={(event) => onUpdate("summaryStyle", event.target.value)} placeholder="Concise executive summary, detailed checklist..." value={form.summaryStyle} />
            </>
          )}

          {step === "prompts" && (
            <>
              <div className="panel-heading">
                <h2>Prepared Prompts <span className="metadata-pill recommended">Recommended</span></h2>
                <button className="secondary-button compact-button" onClick={onAddPrompt} type="button">Add prompt</button>
              </div>
              <p className="form-copy">Prepared prompts are recommended for repeatable tasks, but not required. You can still use this kit with a custom prompt.</p>
              {form.preparedPrompts.length === 0 && (
                <div className="compact-empty">
                  <strong>No prepared prompts yet</strong>
                  <p>Add one if users will run the same task repeatedly. You can skip this step for custom-prompt use.</p>
                </div>
              )}
              {form.preparedPrompts.map((prompt, index) => (
                <article className="guided-card" key={`${prompt.id}-${index}`}>
                  <div className="panel-heading">
                    <h3>Prepared Prompt {index + 1}</h3>
                    <button className="secondary-button compact-button" onClick={() => onRemovePrompt(index)} type="button">Remove</button>
                  </div>
                  <GuidedPromptEditor
                    onAddInput={(seed) => onAddPromptInput(index, seed)}
                    onRemoveInput={(inputIndex) => onRemovePromptInput(index, inputIndex)}
                    onUpdate={(patch) => onUpdatePrompt(index, patch)}
                    onUpdateInput={(inputIndex, patch) => onUpdatePromptInput(index, inputIndex, patch)}
                    prompt={prompt}
                  />
                </article>
              ))}
            </>
          )}

          {step === "examples" && (
            <>
              <div className="panel-heading">
                <h2>Examples <span className="metadata-pill">Optional</span></h2>
                <button className="secondary-button compact-button" onClick={onAddExample} type="button">Add example</button>
              </div>
              <p className="form-copy">Examples show users and AI tools what good prompts and outputs look like. They help with sharing, testing, and future marketplace listings.</p>
              <p className="form-copy">This step is optional. You can skip it and still create a valid Agent Kit.</p>
              {form.examples.map((example, index) => (
                <article className="guided-card" key={`${example.id}-${index}`}>
                  <div className="panel-heading">
                    <h3>Example {index + 1}</h3>
                    <button className="secondary-button compact-button" onClick={() => onRemoveExample(index)} type="button">Remove</button>
                  </div>
                  <label>Prepared prompt</label>
                  <select onChange={(event) => onUpdateExample(index, { promptId: event.target.value })} value={example.promptId}>
                    <option value="">Not tied to a prompt</option>
                    {form.preparedPrompts.map((prompt) => (
                      <option key={prompt.id} value={prompt.id}>{prompt.name || prompt.id}</option>
                    ))}
                  </select>
                  <label>Example prompt</label>
                  <textarea onChange={(event) => onUpdateExample(index, { prompt: event.target.value })} rows={4} value={example.prompt} />
                  <label>Example input values</label>
                  <textarea onChange={(event) => onUpdateExample(index, { inputExamples: event.target.value })} rows={3} value={example.inputExamples} />
                  <label>Expected output example</label>
                  <textarea onChange={(event) => onUpdateExample(index, { output: event.target.value })} rows={5} value={example.output} />
                </article>
              ))}
            </>
          )}

          {step === "review" && (
            <>
              <h2>Review & Create</h2>
              <GuidedReviewSummary form={form} />
              <label className="checkbox-row">
                <input checked={form.force} onChange={(event) => onUpdate("force", event.target.checked)} type="checkbox" />
                <span>Force overwrite generated files</span>
                <HelpTip text="Use only when intentionally replacing generated files in the destination." />
              </label>
              <div className="button-row">
                <button className="primary-button" disabled={isCreating} onClick={() => onCreate("create")} type="button">
                  {isCreating && <InlineSpinner className="button-spinner" />}
                  {isCreating ? "Creating" : "Create Agent Kit"}
                </button>
                <button className="secondary-button" disabled={isCreating} onClick={() => onCreate("validate")} type="button">
                  {isCreating && <InlineSpinner className="button-spinner" />}
                  Create and Validate
                </button>
                <button className="secondary-button" disabled={isCreating} onClick={() => onCreate("validate-add")} type="button">
                  {isCreating && <InlineSpinner className="button-spinner" />}
                  Create, Validate, and Add to My Kits
                </button>
              </div>
            </>
          )}

          {error && <div className="error-state" role="alert">{error}</div>}

          <div className="wizard-nav">
            <button className="secondary-button" disabled={!canGoBack} onClick={() => onStepChange(guidedSteps[stepIndex - 1].id)} type="button">Back</button>
            <button className="primary-button" disabled={!canGoForward} onClick={() => onStepChange(guidedSteps[stepIndex + 1].id)} type="button">Next</button>
          </div>
        </div>

        <div className="results-panel">
          <div className="panel-label">Guided Builder Result</div>
          {isCreating && <LoadingStatus text="Creating Agent Kit and running selected follow-up actions..." />}
          {!isCreating && !result && !validationReport && <p className="state-copy">Complete the steps, then create the kit from Review & Create.</p>}
          {validationReport && <ValidationResults error={null} isLoading={false} report={validationReport} />}
          {result && (
            <div className="create-result">
              <div className="status-banner valid">
                <strong>{form.name || "Agent Kit"} created</strong>
                <span>{result.files.length} generated files</span>
              </div>
              <dl className="report-meta">
                <div><dt>Kit</dt><dd>{form.name}</dd></div>
                <div><dt>Location</dt><dd>{friendlyLocation(result.rootPath)}</dd></div>
                <div><dt>Validation target</dt><dd>{guidedDefaultValidationProfile(form)}</dd></div>
              </dl>
              <div className="button-row">
                <button className="primary-button compact-button" onClick={() => onUseKit(result.rootPath)} type="button">Use Kit</button>
                <button className="secondary-button compact-button" onClick={() => onPackageKit(result.rootPath)} type="button">Package/Export</button>
                <button className="secondary-button compact-button" onClick={() => onValidateKit(result.rootPath)} type="button">Validate</button>
                <button className="secondary-button compact-button" onClick={onOpenFolder} type="button">Open Folder</button>
              </div>
              <details className="advanced-details">
                <summary>Advanced: draft JSON and full path</summary>
                <dl className="report-meta">
                  <div><dt>Full folder path</dt><dd>{result.rootPath}</dd></div>
                </dl>
                <pre className="json-panel">{JSON.stringify(buildGuidedAgentKitDraft(form), null, 2)}</pre>
              </details>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GuidedReviewSummary({ form }: { form: GuidedBuilderState }) {
  return (
    <dl className="report-meta run-meta">
      <div><dt>Kit name</dt><dd>{form.name || "Untitled kit"}</dd></div>
      <div><dt>Domain</dt><dd>{form.domain || "Not selected"}</dd></div>
      <div><dt>Target users</dt><dd>{form.targetUsers || "Not specified"}</dd></div>
      <div><dt>Skills</dt><dd>{form.skills.length}</dd></div>
      <div><dt>Policies</dt><dd>{form.guardrails.filter((item) => item.text.trim()).length}</dd></div>
      <div><dt>Prepared Prompts</dt><dd>{form.preparedPrompts.filter((prompt) => prompt.name.trim()).length}</dd></div>
      <div><dt>Prompt inputs</dt><dd>{form.preparedPrompts.reduce((total, prompt) => total + prompt.inputs.filter((input) => input.label.trim()).length, 0)}</dd></div>
      <div><dt>Templates/outputs</dt><dd>{form.outputTemplate.trim() || form.outputSections.trim() ? "Configured" : "Not configured"}</dd></div>
      <div><dt>Examples</dt><dd>{form.examples.filter((example) => example.prompt.trim()).length}</dd></div>
      <div><dt>Validation target</dt><dd>{guidedDefaultValidationProfile(form)}</dd></div>
      <div><dt>Save location</dt><dd>{friendlyLocation(guidedTargetOutputFolder(form))}</dd></div>
      <div><dt>Document-like outputs</dt><dd>{form.preparedPrompts.some((prompt) => prompt.documentLikeOutput) || form.documentLike ? "Yes" : "No"}</dd></div>
    </dl>
  );
}

function GuidedPromptEditor({
  onAddInput,
  onRemoveInput,
  onUpdate,
  onUpdateInput,
  prompt,
}: {
  onAddInput: (seed?: Partial<GuidedRequiredInput>) => void;
  onRemoveInput: (index: number) => void;
  onUpdate: (patch: Partial<GuidedPreparedPrompt>) => void;
  onUpdateInput: (index: number, patch: Partial<GuidedRequiredInput>) => void;
  prompt: GuidedPreparedPrompt;
}) {
  const placeholders = extractPromptVariables(prompt.template);
  const missingInputs = placeholders.filter((placeholder) =>
    !prompt.inputs.some((input) => input.id === placeholder),
  );
  const preview = renderGuidedPromptPreview(prompt);

  return (
    <>
      <LabelWithHelp htmlFor={`prompt-name-${prompt.id}`} label="Prompt name" help="A friendly name users will choose in Use mode." />
      <input id={`prompt-name-${prompt.id}`} onChange={(event) => onUpdate({ name: event.target.value })} placeholder="Review workbook" value={prompt.name} />

      <details className="advanced-details">
        <summary>Advanced: Prompt ID</summary>
        <input onChange={(event) => onUpdate({ id: slugify(event.target.value) })} value={prompt.id} />
      </details>

      <LabelWithHelp htmlFor={`prompt-description-${prompt.id}`} label="Description" help="Explain when someone should use this prepared prompt." />
      <input id={`prompt-description-${prompt.id}`} onChange={(event) => onUpdate({ description: event.target.value })} value={prompt.description} />

      <LabelWithHelp htmlFor={`prompt-template-${prompt.id}`} label="Prompt template" help="Use variables in double braces, like {{company_name}} or {{reporting_period}}." />
      <textarea
        id={`prompt-template-${prompt.id}`}
        onChange={(event) => onUpdate({ template: event.target.value })}
        placeholder="Review {{company_name}}'s workbook for {{reporting_period}}. Focus on {{review_focus}} and produce a {{output_style}} summary."
        rows={5}
        value={prompt.template}
      />

      {missingInputs.length > 0 && (
        <div className="inline-warning">
          Add inputs for: {missingInputs.join(", ")}
          <div className="button-row">
            {missingInputs.map((placeholder) => (
              <button
                className="secondary-button compact-button"
                key={placeholder}
                onClick={() =>
                  onAddInput({
                    id: placeholder,
                    label: titleCaseFromId(placeholder),
                    placeholder: titleCaseFromId(placeholder),
                  })
                }
                type="button"
              >
                Add {titleCaseFromId(placeholder)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="settings-grid two-column">
        <div>
          <LabelWithHelp htmlFor={`prompt-output-${prompt.id}`} label="Output mode" help="Choose the kind of response this prompt usually produces." />
          <select id={`prompt-output-${prompt.id}`} onChange={(event) => onUpdate({ outputMode: event.target.value as GuidedPreparedPrompt["outputMode"] })} value={prompt.outputMode}>
            <option value="text">text</option>
            <option value="markdown">markdown</option>
            <option value="document">document</option>
          </select>
        </div>
        <label className="checkbox-row">
          <input checked={prompt.documentLikeOutput} onChange={(event) => onUpdate({ documentLikeOutput: event.target.checked })} type="checkbox" />
          <span>Document-like output</span>
          <HelpTip text="When enabled, Use mode emphasizes Markdown download for this prompt." />
        </label>
      </div>

      <LabelWithHelp htmlFor={`prompt-filename-${prompt.id}`} label="Suggested output filename" help="Optional filename users will see when downloading this prompt's result." />
      <input id={`prompt-filename-${prompt.id}`} onChange={(event) => onUpdate({ suggestedFileName: event.target.value })} placeholder="client-memo.md" value={prompt.suggestedFileName} />

      <label>Tags</label>
      <input onChange={(event) => onUpdate({ tags: event.target.value })} placeholder="memo, review, client-facing" value={prompt.tags} />

      <div className="panel-heading">
        <h3>Inputs / variables</h3>
        <button className="secondary-button compact-button" onClick={() => onAddInput()} type="button">Add input</button>
      </div>
      {prompt.inputs.length === 0 && <p className="state-copy compact-state">Add inputs for each variable users should fill in before running.</p>}
      {prompt.inputs.map((input, index) => (
        <GuidedPromptInputEditor
          input={input}
          key={`${input.id}-${index}`}
          onRemove={() => onRemoveInput(index)}
          onUpdate={(patch) => onUpdateInput(index, patch)}
        />
      ))}

      <details className="context-details" open>
        <summary>Prompt preview</summary>
        <pre className="json-panel">{preview || "Add a prompt template to preview it."}</pre>
      </details>
    </>
  );
}

function GuidedPromptInputEditor({
  input,
  onRemove,
  onUpdate,
}: {
  input: GuidedRequiredInput;
  onRemove: () => void;
  onUpdate: (patch: Partial<GuidedRequiredInput>) => void;
}) {
  return (
    <div className="guided-card nested-guided-card">
      <div className="panel-heading">
        <strong>{input.label || "Prompt input"}</strong>
        <button className="secondary-button compact-button" onClick={onRemove} type="button">Remove</button>
      </div>
      <label>Input label</label>
      <input onChange={(event) => onUpdate({ label: event.target.value })} value={input.label} />
      <details className="advanced-details">
        <summary>Advanced: Input ID</summary>
        <input onChange={(event) => onUpdate({ id: slugify(event.target.value) })} value={input.id} />
      </details>
      <label>Description/help text</label>
      <input onChange={(event) => onUpdate({ description: event.target.value })} value={input.description} />
      <div className="settings-grid two-column">
        <label className="checkbox-row">
          <input checked={input.required} onChange={(event) => onUpdate({ required: event.target.checked })} type="checkbox" />
          <span>Required</span>
        </label>
        <label className="checkbox-row">
          <input checked={input.includeInPrompt} onChange={(event) => onUpdate({ includeInPrompt: event.target.checked })} type="checkbox" />
          <span>Include in prompt</span>
        </label>
      </div>
      <label>Type</label>
      <select onChange={(event) => onUpdate({ inputType: event.target.value as PreparedPromptInputType })} value={input.inputType}>
        <option value="short-text">short text</option>
        <option value="long-text">long text</option>
        <option value="choice">choice</option>
        <option value="multi-choice">multi-choice</option>
        <option value="date">date</option>
        <option value="number">number</option>
        <option value="boolean">boolean</option>
      </select>
      <label>Placeholder/example</label>
      <input onChange={(event) => onUpdate({ placeholder: event.target.value })} value={input.placeholder} />
      <label>Default value</label>
      <input onChange={(event) => onUpdate({ defaultValue: event.target.value })} value={input.defaultValue} />
      {(input.inputType === "choice" || input.inputType === "multi-choice") && (
        <>
          <label>Choices</label>
          <textarea onChange={(event) => onUpdate({ choices: event.target.value })} placeholder="One option per line" rows={3} value={input.choices} />
        </>
      )}
    </div>
  );
}

function ValidateScreen({
  currentKitPath,
  profile,
  onKitPathChange,
  onProfileChange,
}: {
  currentKitPath: string;
  profile: ValidationProfile;
  onKitPathChange: (value: string) => void;
  onProfileChange: (value: ValidationProfile) => void;
}) {
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function selectFolder() {
    setIsSelecting(true);
    setError(null);

    try {
      const selectedPath = await forge.selectAgentKitFolder();
      if (selectedPath) {
        onKitPathChange(selectedPath);
        setReport(null);
      }
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    } finally {
      setIsSelecting(false);
    }
  }

  async function validateKit() {
    setIsValidating(true);
    setError(null);
    setReport(null);

    try {
      const validationReport = await forge.validateAgentKit({
        rootPath: currentKitPath,
        profile,
      });
      setReport(validationReport);
      onKitPathChange(validationReport.rootPath);
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    } finally {
      setIsValidating(false);
    }
  }

  return (
    <div className="form-layout">
      <div className="form-panel">
        <h2>Validation Tool</h2>
        <p className="form-copy">
          Validation is usually run from Build, Import, Use, Package / Export, Install on Local Agent, or My Kits.
          This secondary tool is available when you want to check a folder directly.
        </p>
        <LabelWithHelp htmlFor="validate-kit-folder" label="Agent Kit folder" help="Choose the folder that contains the Agent Kit files you want to check." />
        <div className="path-picker">
          <input
            id="validate-kit-folder"
            onChange={(event) => {
              onKitPathChange(event.target.value);
              setReport(null);
            }}
            placeholder="Documents/AgentKitForge/Kits/agent-kit"
            value={currentKitPath}
          />
          <button
            className="icon-button"
            disabled={isSelecting || isValidating}
            onClick={selectFolder}
            title="Select folder"
            type="button"
          >
            <FolderOpen size={18} />
          </button>
        </div>

        <LabelWithHelp htmlFor="validation-profile" label="Validation level" help="Choose how strict this check should be." />
        <select
          id="validation-profile"
          disabled={isValidating}
          onChange={(event) => {
            onProfileChange(event.target.value as ValidationProfile);
            setReport(null);
          }}
          value={profile}
        >
          {validationProfiles.map((validationProfile) => (
            <option key={validationProfile} value={validationProfile}>
              {validationProfile}
            </option>
          ))}
        </select>

        <button
          className="primary-button"
          disabled={isValidating || currentKitPath.trim() === ""}
          onClick={validateKit}
          type="button"
        >
          <CheckCircle2 size={18} />
          {isValidating && <InlineSpinner className="button-spinner" />}
          {isValidating ? "Validating" : "Validate"}
        </button>
      </div>

      <div className="results-panel">
        <div className="panel-label">Results</div>
        <ValidationResults error={error} isLoading={isValidating} report={report} />
      </div>
    </div>
  );
}

// --- Run / Chat (Phase 2c-iii) ----------------------------------------------
// Runs an Agent Kit through the hosted Gateway (managed billing) with the
// desktop's optional "local hands" tool execution. Online-only: requires a
// connected AgentKitProject account. Local-first is preserved — this section
// degrades to a clear sign-in prompt when no account is connected.

const MANAGED_RUN_MODELS = ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-6"] as const;
const DEFAULT_MANAGED_RUN_MODEL = "claude-sonnet-4-6";

type RunChatTranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      toolUseId: string;
      name: string;
      input: unknown;
      status: "running" | "done" | "error";
      result?: unknown;
      error?: string;
    }
  | { kind: "error"; text: string };

function RunChatScreen({
  currentKitPath,
  onKitPathChange,
  onOpenAccount,
  settings,
}: {
  currentKitPath: string;
  onKitPathChange: (path: string) => void;
  onOpenAccount: () => void;
  settings: PublicSettings;
}) {
  const accountConnection = settings.accountConnection || disconnectedAccountConnection();
  const isSignedIn = accountConnection.accountConnectionStatus === "connected";

  const [myKits, setMyKits] = useState<MyKitEntry[]>([]);
  const [kitPath, setKitPath] = useState(currentKitPath);
  const [model, setModel] = useState<string>(DEFAULT_MANAGED_RUN_MODEL);
  const [prompt, setPrompt] = useState("");
  const [enableLocalHands, setEnableLocalHands] = useState(false);
  const [enableRunCommand, setEnableRunCommand] = useState(false);
  const [transcript, setTranscript] = useState<RunChatTranscriptItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [insufficientCredits, setInsufficientCredits] = useState(false);

  useEffect(() => {
    forge
      .listMyKits()
      .then((kits) => setMyKits(kits.filter((kit) => kit.pathExists)))
      .catch(() => {
        // My Kits is best-effort here; the path field still works standalone.
      });
  }, []);

  const selectedKit = myKits.find((kit) => kit.path === kitPath) ?? null;

  function handleSelectKit(path: string) {
    setKitPath(path);
    onKitPathChange(path);
  }

  // Append a streamed assistant text delta, coalescing into the trailing
  // assistant bubble so the transcript reads as one growing message.
  function appendAssistantDelta(delta: string) {
    if (!delta) return;
    setTranscript((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last && last.kind === "assistant") {
        next[next.length - 1] = { kind: "assistant", text: last.text + delta };
      } else {
        next.push({ kind: "assistant", text: delta });
      }
      return next;
    });
  }

  function handleEvent(event: GatewayRunEvent) {
    switch (event.type) {
      case "text":
        appendAssistantDelta((event as { delta?: string }).delta ?? "");
        break;
      case "tool_use": {
        const e = event as { toolUseId: string; name: string; input: unknown };
        setTranscript((current) => [
          ...current,
          {
            kind: "tool",
            toolUseId: e.toolUseId,
            name: e.name,
            input: e.input,
            status: "running",
          },
        ]);
        break;
      }
      case "tool_result": {
        const e = event as { toolUseId: string; result?: unknown; error?: string };
        setTranscript((current) =>
          current.map((item) =>
            item.kind === "tool" && item.toolUseId === e.toolUseId
              ? {
                  ...item,
                  status: e.error ? "error" : "done",
                  result: e.result,
                  error: e.error,
                }
              : item,
          ),
        );
        break;
      }
      case "error": {
        const message = (event as { message?: string }).message;
        if (message) setTranscript((current) => [...current, { kind: "error", text: message }]);
        break;
      }
      default:
        break;
    }
  }

  async function handleRun() {
    if (isRunning) return;
    const trimmedPrompt = prompt.trim();
    if (!kitPath.trim()) {
      setRunError("Select a kit to run.");
      return;
    }
    if (!trimmedPrompt) {
      setRunError("Enter a message to start the run.");
      return;
    }
    setRunError(null);
    setInsufficientCredits(false);
    setIsRunning(true);
    setTranscript((current) => [...current, { kind: "user", text: trimmedPrompt }]);
    setPrompt("");

    const runId = (globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random()}`);

    try {
      const result: GatewayRunResult = await forge.runAgentKitWithGateway(
        {
          runId,
          workspacePath: kitPath,
          model,
          input: trimmedPrompt,
          enableLocalHands,
          enableRunCommand: enableLocalHands && enableRunCommand,
        },
        handleEvent,
      );
      if (result.stopReason === "error") {
        // The error event already rendered inline.
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "INSUFFICIENT_CREDITS") {
        setInsufficientCredits(true);
      } else {
        setRunError(message);
      }
    } finally {
      setIsRunning(false);
    }
  }

  if (!isSignedIn) {
    return (
      <div className="form-panel">
        <div className="empty-state">
          <h2>Run / Chat</h2>
          <p>
            Run an Agent Kit through the hosted gateway with managed billing. This
            online feature needs your AgentKitProject account. Building, validating,
            packaging, and exporting kits never require an account.
          </p>
          <button className="primary-button" type="button" onClick={onOpenAccount}>
            Connect AgentKitProject account
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="form-panel">
      <div className="panel-label">Run / Chat</div>
      <p className="form-help">
        Run an installed Agent Kit through the hosted gateway. Replies stream below.
        Optional “local hands” let the kit read, write, and (if you enable it) run
        commands in the kit’s workspace — every write and command asks for your
        approval first.
      </p>

      <label htmlFor="run-chat-kit">Kit</label>
      <select
        id="run-chat-kit"
        value={kitPath}
        onChange={(event) => handleSelectKit(event.target.value)}
        disabled={isRunning}
      >
        <option value="">Select a kit…</option>
        {myKits.map((kit) => (
          <option key={kit.path} value={kit.path}>
            {kit.name} (v{kit.version})
          </option>
        ))}
      </select>
      {selectedKit?.description ? (
        <p className="form-help">{selectedKit.description}</p>
      ) : null}

      <label htmlFor="run-chat-model">Model (managed billing)</label>
      <select
        id="run-chat-model"
        value={model}
        onChange={(event) => setModel(event.target.value)}
        disabled={isRunning}
      >
        {MANAGED_RUN_MODELS.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={enableLocalHands}
          onChange={(event) => setEnableLocalHands(event.target.checked)}
          disabled={isRunning}
        />
        Enable local hands (experimental) — let the kit read/write files in its
        workspace
      </label>
      {enableLocalHands ? (
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={enableRunCommand}
            onChange={(event) => setEnableRunCommand(event.target.checked)}
            disabled={isRunning}
          />
          Allow run_command (each command asks for explicit approval)
        </label>
      ) : null}

      <label htmlFor="run-chat-prompt">Message</label>
      <textarea
        id="run-chat-prompt"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="Ask the kit to do something…"
        rows={4}
        disabled={isRunning}
      />

      <div className="button-row">
        <button className="primary-button" type="button" onClick={handleRun} disabled={isRunning}>
          {isRunning ? "Running…" : "Run"}
        </button>
        <button
          className="secondary-button"
          type="button"
          onClick={() => {
            setTranscript([]);
            setRunError(null);
            setInsufficientCredits(false);
          }}
          disabled={isRunning || transcript.length === 0}
        >
          Clear
        </button>
      </div>

      {insufficientCredits ? (
        <div className="error-state">
          Insufficient credits to run this kit through the hosted gateway. Add credits
          to your AgentKitProject account, then try again.
        </div>
      ) : null}
      {runError ? <div className="error-state">{runError}</div> : null}

      {transcript.length > 0 ? (
        <div className="results-panel">
          <div className="panel-label">Transcript</div>
          <div className="run-chat-transcript">
            {transcript.map((item, index) => {
              if (item.kind === "user") {
                return (
                  <div key={index} className="run-chat-bubble run-chat-user">
                    <strong>You</strong>
                    <p>{item.text}</p>
                  </div>
                );
              }
              if (item.kind === "assistant") {
                return (
                  <div key={index} className="run-chat-bubble run-chat-assistant">
                    <strong>Kit</strong>
                    <p style={{ whiteSpace: "pre-wrap" }}>{item.text}</p>
                  </div>
                );
              }
              if (item.kind === "error") {
                return (
                  <div key={index} className="run-chat-bubble run-chat-error">
                    {item.text}
                  </div>
                );
              }
              return (
                <div key={index} className="run-chat-tool">
                  <div className="run-chat-tool-head">
                    <code>{item.name}</code>
                    <span className={`run-chat-tool-status run-chat-tool-${item.status}`}>
                      {item.status === "running"
                        ? "running…"
                        : item.status === "error"
                          ? "denied / failed"
                          : "done"}
                    </span>
                  </div>
                  <pre className="run-chat-tool-io">{JSON.stringify(item.input, null, 2)}</pre>
                  {item.error ? <div className="run-chat-tool-error">{item.error}</div> : null}
                  {item.result !== undefined && item.status === "done" ? (
                    <pre className="run-chat-tool-io">
                      {typeof item.result === "string"
                        ? item.result
                        : JSON.stringify(item.result, null, 2)}
                    </pre>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function UseScreen({
  currentKitPath,
  onKitPathChange,
  settings,
}: {
  currentKitPath: string;
  onKitPathChange: (path: string) => void;
  settings: PublicSettings;
}) {
  const [kitPath, setKitPath] = useState(currentKitPath);
  const [myKits, setMyKits] = useState<MyKitEntry[]>([]);
  const [preparedPrompts, setPreparedPrompts] = useState<PreparedPrompt[]>([]);
  const [selectedPromptId, setSelectedPromptId] = useState("");
  const [promptMode, setPromptMode] = useState<UsePromptMode>("custom");
  const [preparedPromptInputs, setPreparedPromptInputs] = useState<Record<string, unknown>>({});
  const [renderedPreparedPrompt, setRenderedPreparedPrompt] = useState("");
  const [promptValidationReport, setPromptValidationReport] = useState<PromptInputValidationReport | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [isLoadingPrompts, setIsLoadingPrompts] = useState(false);
  const [isRenderingPrompt, setIsRenderingPrompt] = useState(false);
  const [userTask, setUserTask] = useState("");
  const [additionalContext, setAdditionalContext] = useState("");
  const [providerId, setProviderId] = useState(settings.defaultAiProviderId || "");
  const [model, setModel] = useState(settings.defaultModel || defaultRuntimeModel);
  const [maxOutputLength, setMaxOutputLength] = useState("1800");
  const [contextMode, setContextMode] = useState<AgentKitContextMode>(settings.preferredContextMode);
  const [contextTarget, setContextTarget] = useState<AgentKitContextTarget>("openai");
  const [validationProfile, setValidationProfile] = useState<ValidationProfile>(settings.preferredValidationProfile);
  const [validateBeforeRun, setValidateBeforeRun] = useState(
    () => window.localStorage.getItem("agentkitforge.defaultValidateBeforeRun") !== "false",
  );
  const [includePolicies, setIncludePolicies] = useState(settings.includePolicies);
  const [includeTemplates, setIncludeTemplates] = useState(settings.includeTemplates);
  const [includeWorkflows, setIncludeWorkflows] = useState(settings.includeWorkflows);
  const [includeReferences, setIncludeReferences] = useState(settings.includeReferences);
  const [includePrompts, setIncludePrompts] = useState(true);
  const [maxSkills, setMaxSkills] = useState("");
  const [runResult, setRunResult] = useState<RunAgentKitResult | null>(null);
  const [runCompletedAt, setRunCompletedAt] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [preRunValidationReport, setPreRunValidationReport] = useState<ValidationReport | null>(null);
  const [starterHint, setStarterHint] = useState<AgentKitStarterHint | null>(null);
  const [starterHintError, setStarterHintError] = useState<string | null>(null);
  const [savedResponsePath, setSavedResponsePath] = useState<string | null>(null);
  const [runFieldErrors, setRunFieldErrors] = useState<{
    apiKey?: string;
    providerId?: string;
    kitPath?: string;
    userTask?: string;
  }>({});
  const [isRunning, setIsRunning] = useState(false);
  const [isLoadingStarterHint, setIsLoadingStarterHint] = useState(false);
  const [isSavingResponse, setIsSavingResponse] = useState(false);
  const [outputPath, setOutputPath] = useState(settings.defaultOutputFolder);
  const [result, setResult] = useState<ExportAgentKitResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ kitPath?: string; outputPath?: string }>({});
  const [isSelectingOutput, setIsSelectingOutput] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [resultCopyState, setResultCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const selectedPrompt = preparedPrompts.find((prompt) => prompt.id === selectedPromptId);
  const selectedKit = myKits.find((kit) => pathsEqualLoose(kit.path, kitPath));
  const activePromptForRun = promptMode === "prepared" ? selectedPrompt : undefined;
  const unresolvedPromptVariables = activePromptForRun
    ? findUnresolvedPromptVariables(renderedPreparedPrompt)
    : [];

  useEffect(() => {
    setKitPath(currentKitPath);
    setResult(null);
    setRunResult(null);
    setRunError(null);
  }, [currentKitPath]);

  useEffect(() => {
    forge.listMyKits()
      .then((kits) => setMyKits(kits.filter((kit) => kit.pathExists)))
      .catch(() => setMyKits([]));
  }, []);

  useEffect(() => {
    const provider = getSelectedProvider(settings, providerId);
    setProviderId((current) => current || settings.defaultAiProviderId || "");
    setModel((current) => current || provider?.model || provider?.defaultModel || settings.defaultModel || defaultRuntimeModel);
    setContextMode(settings.preferredContextMode);
    setValidationProfile(settings.preferredValidationProfile);
    setIncludePolicies(settings.includePolicies);
    setIncludeTemplates(settings.includeTemplates);
    setIncludeWorkflows(settings.includeWorkflows);
    setIncludeReferences(settings.includeReferences);
    setOutputPath((current) => current || settings.defaultOutputFolder);
  }, [settings]);

  useEffect(() => {
    const trimmedPath = kitPath.trim();
    setPreparedPrompts([]);
    setSelectedPromptId("");
    setPreparedPromptInputs({});
    setRenderedPreparedPrompt("");
    setPromptValidationReport(null);
    setPromptError(null);

    if (!trimmedPath) {
      return;
    }

    let isCurrent = true;
    setIsLoadingPrompts(true);
    forge.listPreparedPrompts(trimmedPath)
      .then((prompts) => {
        if (!isCurrent) {
          return;
        }
        setPreparedPrompts(prompts);
        setSelectedPromptId(prompts[0]?.id ?? "");
        setPreparedPromptInputs(defaultPreparedPromptInputs(prompts[0]));
        setPromptMode(prompts.length > 0 ? "prepared" : "custom");
      })
      .catch((caughtError) => {
        if (isCurrent) {
          setPromptError(errorToMessage(caughtError));
        }
      })
      .finally(() => {
        if (isCurrent) {
          setIsLoadingPrompts(false);
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [kitPath]);

  useEffect(() => {
    if (!selectedPrompt || promptMode !== "prepared" || !kitPath.trim()) {
      setRenderedPreparedPrompt("");
      setPromptValidationReport(null);
      return;
    }

    let isCurrent = true;
    setIsRenderingPrompt(true);
    setPromptError(null);
    forge.renderPreparedPrompt({
        rootPath: kitPath,
        promptId: selectedPrompt.id,
        inputValues: preparedPromptInputs,
      })
      .then((result) => {
        if (!isCurrent) {
          return;
        }
        setPromptValidationReport(result.validationReport);
        setRenderedPreparedPrompt(result.renderedPrompt ?? "");
      })
      .catch((caughtError) => {
        if (isCurrent) {
          setPromptError(errorToMessage(caughtError));
          setRenderedPreparedPrompt("");
        }
      })
      .finally(() => {
        if (isCurrent) {
          setIsRenderingPrompt(false);
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [kitPath, selectedPromptId, preparedPromptInputs, promptMode]);

  useEffect(() => {
    const trimmedPath = kitPath.trim();
    setStarterHint(null);
    setStarterHintError(null);

    if (!trimmedPath) {
      return;
    }

    let isCurrent = true;
    setIsLoadingStarterHint(true);

    forge.getAgentKitStarterHint(trimmedPath)
      .then((hint) => {
        if (isCurrent) {
          setStarterHint(hint);
        }
      })
      .catch((caughtError) => {
        if (isCurrent) {
          setStarterHintError(errorToMessage(caughtError));
        }
      })
      .finally(() => {
        if (isCurrent) {
          setIsLoadingStarterHint(false);
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [kitPath]);

  function updateSelectedUseKitPath(path: string) {
    setKitPath(path);
    setResult(null);
    setRunResult(null);
    setFieldErrors((current) => ({ ...current, kitPath: undefined }));
    setRunFieldErrors((current) => ({ ...current, kitPath: undefined }));
  }

  function choosePreparedPrompt(promptId: string) {
    const prompt = preparedPrompts.find((entry) => entry.id === promptId);
    setSelectedPromptId(promptId);
    setPreparedPromptInputs(defaultPreparedPromptInputs(prompt));
    setRunResult(null);
    setRunError(null);
  }

  function choosePromptMode(mode: UsePromptMode) {
    setPromptMode(mode);
    setRunResult(null);
    setRunError(null);
    setResultCopyState("idle");
    if (mode === "prepared" && preparedPrompts.length > 0 && !selectedPromptId) {
      choosePreparedPrompt(preparedPrompts[0].id);
    }
  }

  function updatePreparedPromptInput(input: PreparedPromptInput, value: unknown) {
    setPreparedPromptInputs((current) => ({ ...current, [input.id]: value }));
    setRunResult(null);
    setRunError(null);
  }

  async function runInsideForge() {
    const taskForRun = activePromptForRun ? renderedPreparedPrompt : userTask;
    const unresolvedVariables = activePromptForRun ? findUnresolvedPromptVariables(taskForRun) : [];
    const validationErrors = validateRunForm(settings, providerId, kitPath, taskForRun);
    setRunFieldErrors(validationErrors);
    setRunError(null);
    setRunResult(null);
    setRunCompletedAt(null);
    setPreRunValidationReport(null);
    setSavedResponsePath(null);
    setResultCopyState("idle");

    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    if (activePromptForRun && promptValidationReport && !promptValidationReport.valid) {
      setRunError("Complete the required prompt inputs before running.");
      return;
    }

    if (activePromptForRun && !renderedPreparedPrompt.trim()) {
      setRunError("Complete the prompt inputs so AgentKitForge can preview the prepared prompt before running.");
      return;
    }

    if (unresolvedVariables.length > 0) {
      setRunError(`This prepared prompt still has unresolved inputs: ${unresolvedVariables.join(", ")}.`);
      return;
    }

    setIsRunning(true);

    try {
      if (validateBeforeRun) {
        const validationReport = await forge.validateAgentKit({
          rootPath: kitPath,
          profile: validationProfile,
        });
        setPreRunValidationReport(validationReport);

        if (!validationReport.valid) {
          setRunError(
            "Validation failed. Fix the issues below, or turn off Validate before running if you intentionally want to continue.",
          );
          return;
        }
      }

      const runtimeResult = await forge.runAgentKitWithAi({
          kitPath,
          userTask: taskForRun,
          additionalContext: additionalContext.trim(),
          providerId,
          model,
          maxOutputLength: Number.parseInt(maxOutputLength, 10) || undefined,
          contextMode,
          target: contextTarget,
          includePolicies,
          includeTemplates,
          includeWorkflows,
          includeReferences,
          includePrompts,
          maxSkills: contextMode === "triggered" ? Number.parseInt(maxSkills, 10) || undefined : undefined,
        });
      setRunResult(runtimeResult);
      setRunCompletedAt(new Date().toISOString());
    } catch (caughtError) {
      setRunError(errorToMessage(caughtError));
    } finally {
      setIsRunning(false);
    }
  }

  async function selectOutputFile() {
    setIsSelectingOutput(true);
    setError(null);

    try {
      const selectedPath = await forge.selectOnefileOutputPath();
      if (selectedPath) {
        setOutputPath(selectedPath);
        setResult(null);
        setFieldErrors((current) => ({ ...current, outputPath: undefined }));
      }
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    } finally {
      setIsSelectingOutput(false);
    }
  }

  async function selectOutputFolder() {
    setIsSelectingOutput(true);
    setError(null);

    try {
      const selectedPath = await forge.selectAgentKitFolder();
      if (selectedPath) {
        setOutputPath(selectedPath);
        setResult(null);
        setFieldErrors((current) => ({ ...current, outputPath: undefined }));
      }
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    } finally {
      setIsSelectingOutput(false);
    }
  }

  async function exportOneFile() {
    const validationErrors = validateExportForm(kitPath, outputPath);
    setFieldErrors(validationErrors);
    setError(null);
    setResult(null);
    setCopyState("idle");

    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setIsExporting(true);

    try {
      const exportResult = await forge.exportAgentKitOneFile({
          rootPath: kitPath,
          outputPath,
        });
      setResult(exportResult);
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    } finally {
      setIsExporting(false);
    }
  }

  async function copyStarterPrompt() {
    try {
      await navigator.clipboard.writeText(starterPrompt);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  async function copyRunResult() {
    if (!runResult?.response) {
      return;
    }

    try {
      await navigator.clipboard.writeText(runResult.response);
      setResultCopyState("copied");
    } catch {
      setResultCopyState("failed");
    }
  }

  async function saveRunResult() {
    if (!runResult?.response) {
      return;
    }

    setIsSavingResponse(true);
    setRunError(null);

    try {
      const selectedPath = await forge.selectForgeResponseOutputPath(responseDownloadName(activePromptForRun, kitPath, "md"));
      if (!selectedPath) {
        return;
      }

      const saveResult = await forge.saveMarkdownFile({
        input: {
          content: formatRunResultMarkdown(
            runResult,
            runCompletedAt,
            kitPath,
            contextMode,
            validationProfile,
            validateBeforeRun,
          ),
        },
        outputPath: selectedPath,
      });
      setSavedResponsePath(saveResult.filePath);
    } catch (caughtError) {
      setRunError(errorToMessage(caughtError));
    } finally {
      setIsSavingResponse(false);
    }
  }

  async function saveRunResultText() {
    if (!runResult?.response) {
      return;
    }

    setIsSavingResponse(true);
    setRunError(null);

    try {
      const selectedPath = await forge.selectForgeResponseTextOutputPath(responseDownloadName(activePromptForRun, kitPath, "txt"));
      if (!selectedPath) {
        return;
      }

      const saveResult = await forge.saveMarkdownFile({
        input: {
          content: runResult.response,
        },
        outputPath: selectedPath,
      });
      setSavedResponsePath(saveResult.filePath);
    } catch (caughtError) {
      setRunError(errorToMessage(caughtError));
    } finally {
      setIsSavingResponse(false);
    }
  }

  function clearRunResult() {
    setRunResult(null);
    setRunCompletedAt(null);
    setPreRunValidationReport(null);
    setRunError(null);
    setSavedResponsePath(null);
    setResultCopyState("idle");
  }

  return (
    <div className="use-screen">
      <div className="build-layout">
        <div className="form-panel">
          <h2>Use inside Forge</h2>

          {settings.aiProviders.length === 0 && (
            <div className="inline-warning">Add an AI provider in Settings before running.</div>
          )}

          <UseKitSelector
            currentKitPath={kitPath}
            kits={myKits}
            onChange={(nextPath) => {
              updateSelectedUseKitPath(nextPath);
              onKitPathChange(nextPath);
            }}
            selectedKit={selectedKit}
          />
          <FieldError message={runFieldErrors.kitPath} />
          <FieldError message={runFieldErrors.apiKey} />

          <LabelWithHelp
            htmlFor="runtime-provider"
            label="AI provider"
            help="Choose the saved AI provider that will answer using this kit."
          />
          <select
            id="runtime-provider"
            onChange={(event) => {
              const provider = settings.aiProviders.find((item) => item.id === event.target.value);
              setProviderId(event.target.value);
              setModel(provider?.model || provider?.defaultModel || model);
              setRunResult(null);
              setRunError(null);
            }}
            value={providerId}
          >
            <option value="">Select provider</option>
            {settings.aiProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name} ({provider.providerType})
              </option>
            ))}
          </select>
          <FieldError message={runFieldErrors.providerId} />

          <UsePromptModeSelector
            disabledPrepared={preparedPrompts.length === 0}
            mode={promptMode}
            onChange={choosePromptMode}
            promptCount={preparedPrompts.length}
          />

          {preparedPrompts.length === 0 && !isLoadingPrompts && (
            <div className="inline-warning">
              This kit does not include prepared prompts yet. You can still write your own prompt.
            </div>
          )}

          {promptMode === "prepared" && (
            <>
              <PreparedPromptSelector
                isLoading={isLoadingPrompts}
                onSelectPrompt={choosePreparedPrompt}
                prompts={preparedPrompts}
                selectedPromptId={selectedPromptId}
              />
              {selectedPrompt && (
                <PreparedPromptInputFields
                  inputs={selectedPrompt.inputs}
                  onChange={updatePreparedPromptInput}
                  values={preparedPromptInputs}
                />
              )}
            </>
          )}

          {promptMode === "custom" && (
            <>
              <LabelWithHelp
                htmlFor="runtime-task"
                label="What do you want this kit to help with?"
                help="Describe what you need. The kit instructions and your prompt will be sent to the selected provider."
              />
              <textarea
                id="runtime-task"
                onChange={(event) => {
                  setUserTask(event.target.value);
                  setRunResult(null);
                }}
                placeholder="Describe the task you want the selected Agent Kit to perform..."
                rows={6}
                value={userTask}
              />
              <FieldError message={runFieldErrors.userTask} />
            </>
          )}

          {promptValidationReport && !promptValidationReport.valid && (
            <IssueGroup issues={promptValidationReport.issues} severity="error" />
          )}
          {unresolvedPromptVariables.length > 0 && (
            <div className="error-state" role="alert">
              This prepared prompt still has unresolved inputs: {unresolvedPromptVariables.join(", ")}.
            </div>
          )}
          {promptError && <div className="error-state" role="alert">{promptError}</div>}

          <StarterHintPanel
            error={starterHintError}
            hint={starterHint}
            isLoading={isLoadingStarterHint}
          />

          <details className="advanced-details">
            <summary>
              Additional Context
              <HelpTip text="Optional. Add extra notes, constraints, or background for this run." />
            </summary>
            <LabelWithHelp
              htmlFor="runtime-context"
              label="Additional context"
              help="Optional. Add extra notes, constraints, or background for this run."
            />
            <textarea
              id="runtime-context"
              onChange={(event) => {
                setAdditionalContext(event.target.value);
                setRunResult(null);
              }}
              placeholder="Optional notes, constraints, or background for this run."
              rows={4}
              value={additionalContext}
            />
          </details>

          <LabelWithHelp
            htmlFor="runtime-model"
            label="Model"
            help="Use the provider default, choose a suggestion, or enter a custom model ID."
          />
          <ModelInput
            id="runtime-model"
            model={model}
            onModelChange={setModel}
            providerType={getSelectedProvider(settings, providerId)?.providerType}
          />

          <details className="advanced-details">
            <summary>
              Advanced Settings
              <HelpTip text="Optional controls for context, validation, references, and response length." />
            </summary>
          <div className="settings-grid two-column">
            <div>
              <LabelWithHelp htmlFor="runtime-context-mode" label="Context mode" help="All includes the kit broadly. Triggered uses the best-matching skills first." />
              <select
                id="runtime-context-mode"
                onChange={(event) => setContextMode(event.target.value as AgentKitContextMode)}
                value={contextMode}
              >
                {contextModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <LabelWithHelp htmlFor="runtime-target" label="Target" help="Tunes context for the selected AI runtime format." />
              <select
                id="runtime-target"
                onChange={(event) => setContextTarget(event.target.value as AgentKitContextTarget)}
                value={contextTarget}
              >
                {contextTargets.map((target) => (
                  <option key={target} value={target}>
                    {target}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="settings-grid two-column">
            <div>
              <LabelWithHelp htmlFor="runtime-validation-profile" label="Validation level" help="Choose how strict the pre-run kit check should be." />
              <select
                id="runtime-validation-profile"
                onChange={(event) => setValidationProfile(event.target.value as ValidationProfile)}
                value={validationProfile}
              >
                {validationProfiles.map((profile) => (
                  <option key={profile} value={profile}>
                    {profile}
                  </option>
                ))}
              </select>
            </div>
            <label className="checkbox-row aligned-checkbox" htmlFor="runtime-validate-before-run">
              <input
                checked={validateBeforeRun}
                id="runtime-validate-before-run"
                onChange={(event) => setValidateBeforeRun(event.target.checked)}
                type="checkbox"
              />
              <span>Validate before running</span>
              <HelpTip text="Blocks the run if the kit has validation issues unless you turn this off." />
            </label>
          </div>

          <LabelWithHelp htmlFor="runtime-max-skills" label="Max skills" help="Optional limit for triggered mode when the kit has many skills." />
          <input
            disabled={contextMode !== "triggered"}
            id="runtime-max-skills"
            min="1"
            onChange={(event) => setMaxSkills(event.target.value)}
            placeholder="Optional for triggered mode"
            type="number"
            value={maxSkills}
          />

          <div className="checkbox-grid">
            <label className="checkbox-row" htmlFor="include-policies">
              <input
                checked={includePolicies}
                id="include-policies"
                onChange={(event) => setIncludePolicies(event.target.checked)}
                type="checkbox"
              />
              <span>Include policies</span>
              <HelpTip text="Adds guardrails from the kit to the AI context." />
            </label>
            <label className="checkbox-row" htmlFor="include-templates">
              <input
                checked={includeTemplates}
                id="include-templates"
                onChange={(event) => setIncludeTemplates(event.target.checked)}
                type="checkbox"
              />
              <span>Include templates</span>
              <HelpTip text="Adds output templates when the kit defines them." />
            </label>
            <label className="checkbox-row" htmlFor="include-workflows">
              <input
                checked={includeWorkflows}
                id="include-workflows"
                onChange={(event) => setIncludeWorkflows(event.target.checked)}
                type="checkbox"
              />
              <span>Include workflows</span>
              <HelpTip text="Adds workflow instructions when the kit defines them." />
            </label>
            <label className="checkbox-row" htmlFor="include-references">
              <input
                checked={includeReferences}
                id="include-references"
                onChange={(event) => setIncludeReferences(event.target.checked)}
                type="checkbox"
              />
              <span>Include references</span>
              <HelpTip text="References can be large, so they are usually off by default." />
            </label>
            <label className="checkbox-row" htmlFor="include-prompts">
              <input
                checked={includePrompts}
                id="include-prompts"
                onChange={(event) => setIncludePrompts(event.target.checked)}
                type="checkbox"
              />
              <span>Include prepared prompts</span>
              <HelpTip text="Includes reusable prompt definitions in the kit context." />
            </label>
          </div>

          <LabelWithHelp htmlFor="runtime-max-output" label="Max output tokens" help="Optional response length limit for the selected provider." />
          <input
            id="runtime-max-output"
            min="256"
            onChange={(event) => setMaxOutputLength(event.target.value)}
            type="number"
            value={maxOutputLength}
          />
          </details>

          <PromptPreview
            additionalContext={additionalContext}
            preparedPrompt={activePromptForRun}
            renderedPrompt={renderedPreparedPrompt}
            isRendering={isRenderingPrompt}
            mode={promptMode}
            userTask={userTask}
          />

          <button
            className="primary-button"
            disabled={isRunning}
            onClick={runInsideForge}
            type="button"
          >
            <PlayCircle size={18} />
            {isRunning && <InlineSpinner className="button-spinner" />}
            {isRunning ? "Running" : "Run with AI"}
          </button>
        </div>

        <div className="results-panel runtime-results-panel">
          <div className="panel-label">Forge Result</div>
          <ForgeRunResults
            copyState={resultCopyState}
            documentLikeOutput={selectedPrompt?.documentLikeOutput === true}
            error={runError}
            isLoading={isRunning}
            isSavingResponse={isSavingResponse}
            onCopyResult={copyRunResult}
            onClearResult={clearRunResult}
            onSaveResult={saveRunResult}
            onSaveResultText={saveRunResultText}
            preRunValidationReport={preRunValidationReport}
            result={runResult}
            runCompletedAt={runCompletedAt}
            savedResponsePath={savedResponsePath}
            selectedContextMode={contextMode}
            promptMode={promptMode}
            preparedPromptName={activePromptForRun?.name}
            selectedKitPath={kitPath}
            selectedKitName={selectedKit?.name}
            validationProfile={validationProfile}
          />
        </div>
      </div>

      <div className="build-layout">
        <div className="form-panel">
          <h2>Prepare for Web Assistant</h2>
          <p className="form-copy">
            Creates a one-file Markdown version of your Agent Kit and a starter prompt for tools
            like ChatGPT or Claude. This does not install anything; it prepares files you can upload
            or paste.
          </p>
          <div className="artifact-explainer">
            <article>
              <strong>Use inside Forge</strong>
              <HelpTip text="AgentKitForge sends your prompt and kit context to your selected AI provider." />
              <p>AgentKitForge runs the kit with your selected AI provider.</p>
            </article>
            <article>
              <strong>Prepare for Web Assistant</strong>
              <HelpTip text="Creates a Markdown file and starter prompt for manual upload or paste." />
              <p>Creates a file and prompt for manual upload or paste into web assistants.</p>
            </article>
            <article>
              <strong>Install on Local Agent</strong>
              <HelpTip text="Copies or exports kit content into supported external tool folders." />
              <p>Exports the kit into supported tools like Codex or Claude Code.</p>
            </article>
            <article>
              <strong>Package / Export</strong>
              <HelpTip text="Creates shareable kit files without installing them into another tool." />
              <p>Creates shareable package artifacts for import, sharing, or manual use.</p>
            </article>
          </div>

          <LabelWithHelp htmlFor="use-kit" label="Agent Kit" help="Choose the kit to prepare for manual use in a web assistant." />
          <select
            disabled={isExporting || isRunning}
            id="use-kit"
            onChange={(event) => {
              const nextPath = event.target.value;
              setKitPath(nextPath);
              onKitPathChange(nextPath);
              setResult(null);
            }}
            value={kitPath}
          >
            <option value="">Choose from My Kits</option>
            {myKits.map((kit) => (
              <option key={kit.path} value={kit.path}>
                {kit.name} ({formatDisplayVersion(kit.version)})
              </option>
            ))}
          </select>
          <FieldError message={fieldErrors.kitPath} />

          <LabelWithHelp htmlFor="onefile-output" label="Output file or folder" help="Choose where to save the one-file Markdown bundle." />
          <div className="path-picker double-action">
            <input
              id="onefile-output"
              onChange={(event) => {
                setOutputPath(event.target.value);
                setResult(null);
              }}
              placeholder="Documents/AgentKitForge/Exports/agent-kit.md"
              value={outputPath}
            />
            <button
              className="icon-button"
              disabled={isSelectingOutput || isExporting}
              onClick={selectOutputFile}
              title="Select output file"
              type="button"
            >
              <FileArchive size={18} />
            </button>
            <button
              className="icon-button"
              disabled={isSelectingOutput || isExporting}
              onClick={selectOutputFolder}
              title="Select output folder"
              type="button"
            >
              <FolderOpen size={18} />
            </button>
          </div>
          <FieldError message={fieldErrors.outputPath} />

          <button
            className="primary-button"
            disabled={isExporting}
            onClick={exportOneFile}
            type="button"
          >
            <FileArchive size={18} />
            {isExporting && <InlineSpinner className="button-spinner" />}
            {isExporting ? "Exporting" : "Export one-file Markdown"}
          </button>
        </div>

        <div className="results-panel">
          <div className="panel-label">Export Result</div>
          <OneFileExportResults
            copyState={copyState}
            error={error}
            isLoading={isExporting}
            onCopyStarterPrompt={copyStarterPrompt}
            result={result}
          />
        </div>
      </div>
    </div>
  );
}

function PackageExportScreen({
  currentKitPath,
  onKitPathChange,
  onKitPackaged,
  settings,
}: {
  currentKitPath: string;
  onKitPathChange: (path: string) => void;
  onKitPackaged: (path: string) => void;
  settings: PublicSettings;
}) {
  const [kitPath, setKitPath] = useState(currentKitPath);
  const [myKits, setMyKits] = useState<MyKitEntry[]>([]);
  const [outputFolder, setOutputFolder] = useState(appExportsFolder(settings));
  const [validationProfile, setValidationProfile] = useState<ValidationProfile>(
    settings.preferredValidationProfile,
  );
  const [validateBeforePackaging, setValidateBeforePackaging] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<{ kitPath?: string; outputFolder?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [validationReport, setValidationReport] = useState<ValidationReport | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactResult[]>([]);
  const [isSelectingKit, setIsSelectingKit] = useState(false);
  const [isSelectingOutput, setIsSelectingOutput] = useState(false);
  const [isPackaging, setIsPackaging] = useState(false);
  const [isExportingOneFile, setIsExportingOneFile] = useState(false);
  const [copyState, setCopyState] = useState<string | null>(null);
  const selectedKit = myKits.find((kit) => pathsEqualLoose(kit.path, kitPath));

  useEffect(() => {
    setKitPath(currentKitPath);
  }, [currentKitPath]);

  useEffect(() => {
    setOutputFolder((current) => current || appExportsFolder(settings));
    setValidationProfile(settings.preferredValidationProfile);
  }, [settings.defaultOutputFolder, settings.preferredValidationProfile]);

  useEffect(() => {
    forge.listMyKits()
      .then((kits) => {
        const availableKits = kits.filter((kit) => kit.pathExists);
        setMyKits(availableKits);
        if (!kitPath && availableKits.length > 0) {
          setKitPath(availableKits[0].path);
          onKitPathChange(availableKits[0].path);
        }
      })
      .catch(() => setMyKits([]));
  }, []);

  async function selectKitFolder() {
    setIsSelectingKit(true);
    setError(null);

    try {
      const selectedPath = await forge.selectAgentKitFolder();
      if (selectedPath) {
        setKitPath(selectedPath);
        onKitPathChange(selectedPath);
        setValidationReport(null);
        setFieldErrors((current) => ({ ...current, kitPath: undefined }));
      }
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    } finally {
      setIsSelectingKit(false);
    }
  }

  async function selectOutputFolder() {
    setIsSelectingOutput(true);
    setError(null);

    try {
      const selectedPath = await forge.selectAgentKitFolder();
      if (selectedPath) {
        setOutputFolder(selectedPath);
        setFieldErrors((current) => ({ ...current, outputFolder: undefined }));
      }
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    } finally {
      setIsSelectingOutput(false);
    }
  }

  async function validateForPackaging() {
    const validationReport = await forge.validateAgentKit({
      rootPath: kitPath,
      profile: validationProfile,
    });
    setValidationReport(validationReport);

    if (!validationReport.valid) {
      throw new Error(
        "Validation failed. Fix the reported issues or disable validation before packaging.",
      );
    }
  }

  async function packageZip() {
    const validationErrors = validatePackageExportForm(kitPath, outputFolder);
    setFieldErrors(validationErrors);
    setError(null);
    setCopyState(null);

    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setIsPackaging(true);

    try {
      if (validateBeforePackaging) {
        await validateForPackaging();
      } else {
        setValidationReport(null);
      }

      const result = await forge.packageAgentKit({ rootPath: kitPath, outputFolder });
      onKitPackaged(kitPath);
      setArtifacts((current) => [
        { artifactPath: result.artifactPath, artifactType: ".agentkit.zip" },
        ...current,
      ]);
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    } finally {
      setIsPackaging(false);
    }
  }

  async function exportOneFile() {
    const validationErrors = validatePackageExportForm(kitPath, outputFolder);
    setFieldErrors(validationErrors);
    setError(null);
    setCopyState(null);

    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setIsExportingOneFile(true);

    try {
      const result = await forge.exportAgentKitOneFile({ rootPath: kitPath, outputPath: outputFolder });
      setArtifacts((current) => [
        { artifactPath: result.filePath, artifactType: ".onefile.md" },
        ...current,
      ]);
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    } finally {
      setIsExportingOneFile(false);
    }
  }

  async function openOutputFolder() {
    if (outputFolder.trim() === "") {
      setError("Output folder is required.");
      return;
    }

    try {
      await forge.openFolder(outputFolder);
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    }
  }

  async function copyArtifactPath(artifactPath: string) {
    try {
      await navigator.clipboard.writeText(artifactPath);
      setCopyState(artifactPath);
    } catch {
      setError("Clipboard access failed. Select and copy the artifact path.");
    }
  }

  return (
    <div className="build-layout">
      <div className="form-panel">
        <h2>Package / Export</h2>

        <p className="form-copy">Create shareable artifacts from a kit in My Kits.</p>

        <LabelWithHelp htmlFor="package-kit-folder" label="Agent Kit" help="Choose from My Kits first. Add an existing kit only if it is not in your library yet." />
        <div className="path-picker">
          <select
            id="package-kit-folder"
            onChange={(event) => {
              const nextPath = event.target.value;
              setKitPath(nextPath);
              onKitPathChange(nextPath);
              setValidationReport(null);
            }}
            value={kitPath}
          >
            <option value="">Choose from My Kits</option>
            {myKits.map((kit) => (
              <option key={kit.path} value={kit.path}>{kit.name} ({formatDisplayVersion(kit.version)})</option>
            ))}
            {kitPath && !myKits.some((kit) => pathsEqualLoose(kit.path, kitPath)) && (
              <option value={kitPath}>{friendlyLocation(kitPath)}</option>
            )}
          </select>
          <button
            className="icon-button"
            disabled={isSelectingKit || isPackaging || isExportingOneFile}
            onClick={selectKitFolder}
            title="Select kit folder"
            type="button"
          >
            <FolderOpen size={18} />
          </button>
        </div>
        <button className="secondary-button compact-button" disabled={isSelectingKit || isPackaging || isExportingOneFile} onClick={selectKitFolder} type="button">
          Add existing kit...
        </button>
        <FieldError message={fieldErrors.kitPath} />
        {selectedKit && <SelectedKitSummaryCard kit={selectedKit} />}

        <div className="artifact-explainer">
          <article>
            <strong>Full Agent Kit Package (.agentkit.zip)</strong>
            <HelpTip text="A complete portable kit package for import, sharing, or future publishing." />
            <p>Best for importing into AgentKitForge, sharing, or publishing later. Includes structure, metadata, skills, policies, prompts, templates, examples, and other kit files.</p>
          </article>
          <article>
            <strong>One-File Markdown (.onefile.md)</strong>
            <HelpTip text="A manual-use Markdown bundle for web assistants, not a full package." />
            <p>Best for uploading or pasting into web assistants like ChatGPT or Claude. Easier to use manually, but not a full Agent Kit package.</p>
          </article>
        </div>

        <LabelWithHelp htmlFor="package-output-folder" label="Output location" help="Exports save to AgentKitForge Exports by default." />
        <div className="friendly-location-row">
          <span>Save exports to: {isDefaultExportsFolder(outputFolder) ? "AgentKitForge Exports" : friendlyLocation(outputFolder)}</span>
          <button className="secondary-button compact-button" disabled={isSelectingOutput || isPackaging || isExportingOneFile} onClick={selectOutputFolder} type="button">
            <FolderOpen size={18} />
            Change location
          </button>
        </div>
        <details className="advanced-details">
          <summary>Show full output path</summary>
          <input
            id="package-output-folder"
            onChange={(event) => setOutputFolder(event.target.value)}
            placeholder="Full output folder path"
            value={outputFolder}
          />
        </details>
        <FieldError message={fieldErrors.outputFolder} />

        <label className="checkbox-row" htmlFor="validate-before-package">
          <input
            checked={validateBeforePackaging}
            id="validate-before-package"
            onChange={(event) => setValidateBeforePackaging(event.target.checked)}
            type="checkbox"
          />
          <span>Run validation before packaging</span>
        </label>

        <LabelWithHelp htmlFor="package-validation-profile" label="Validation level" help="Choose how strict the check should be before creating artifacts." />
        <select
          disabled={!validateBeforePackaging}
          id="package-validation-profile"
          onChange={(event) => setValidationProfile(event.target.value as ValidationProfile)}
          value={validationProfile}
        >
          {validationProfiles.map((profile) => (
            <option key={profile} value={profile}>
              {profile}
            </option>
          ))}
        </select>

        <div className="button-row">
          <button
            className="primary-button"
            disabled={isPackaging}
            onClick={packageZip}
            type="button"
          >
            <PackageOpen size={18} />
            {isPackaging && <InlineSpinner className="button-spinner" />}
            {isPackaging ? "Packaging" : "Package .agentkit.zip"}
          </button>
          <button
            className="secondary-button"
            disabled={isExportingOneFile}
            onClick={exportOneFile}
            type="button"
          >
            <FileArchive size={18} />
            {isExportingOneFile && <InlineSpinner className="button-spinner" />}
            {isExportingOneFile ? "Exporting" : "Export .onefile.md"}
          </button>
        </div>
      </div>

      <div className="results-panel">
        <div className="panel-label">Artifacts</div>
        <PackageExportResults
          artifacts={artifacts}
          copyState={copyState}
          error={error}
          isLoading={isPackaging || isExportingOneFile}
          onCopyArtifactPath={copyArtifactPath}
          onOpenOutputFolder={openOutputFolder}
          outputFolder={outputFolder}
          validationReport={validationReport}
        />
      </div>
    </div>
  );
}

function MarketSubmitScreen({
  currentKitPath,
  onAccountReconnectRequired,
  onKitPathChange,
  onOpenAccount,
  onOpenMyKits,
  onSettingsChange,
  settings,
}: {
  currentKitPath: string;
  onAccountReconnectRequired: (message: string) => void;
  onKitPathChange: (path: string) => void;
  onOpenAccount: () => void;
  onOpenMyKits: () => void;
  onSettingsChange: (settings: PublicSettings) => void;
  settings: PublicSettings;
}) {
  const [kitPath, setKitPath] = useState(currentKitPath);
  const [myKits, setMyKits] = useState<MyKitEntry[]>([]);
  const [validationProfile, setValidationProfile] = useState<ValidationProfile>("publishable");
  const [validationReport, setValidationReport] = useState<ValidationReport | null>(null);
  const [phase, setPhase] = useState<MarketSubmitPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitHostedMarketKitResult | null>(null);
  const [duplicateVersion, setDuplicateVersion] = useState<{ current: string; next: string } | null>(null);
  const [isBumpingVersion, setIsBumpingVersion] = useState(false);
  const selectedKit = myKits.find((kit) => pathsEqualLoose(kit.path, kitPath));
  const isSubmitting = ["validating", "packaging", "uploading", "creating"].includes(phase);
  const accountConnection = settings.accountConnection || disconnectedAccountConnection();
  const isConnected = accountConnection.accountConnectionStatus === "connected";
  const hostedMarket = defaultExternalServiceConnections.find((connection) => connection.id === "agentkitproject-market");
  const hostedSubmitConnection = hostedMarket
    ? { ...hostedMarket, status: isConnected ? "connected" as const : "disconnected" as const }
    : undefined;

  useEffect(() => {
    setKitPath(currentKitPath);
  }, [currentKitPath]);

  useEffect(() => {
    forge.listMyKits()
      .then((kits) => {
        const availableKits = kits.filter((kit) => kit.pathExists);
        setMyKits(availableKits);
        if (!kitPath && availableKits.length > 0) {
          setKitPath(availableKits[0].path);
          onKitPathChange(availableKits[0].path);
        }
      })
      .catch(() => setMyKits([]));
  }, []);

  async function refreshMyKits() {
    try {
      const kits = await forge.listMyKits();
      setMyKits(kits.filter((kit) => kit.pathExists));
    } catch {
      // Non-fatal: the version label may lag, but submit already used the bumped manifest.
    }
  }

  async function submitToHostedMarket() {
    setError(null);
    setResult(null);
    setValidationReport(null);
    setDuplicateVersion(null);

    if (!kitPath.trim()) {
      setPhase("failed");
      setError("Choose an Agent Kit before submitting to Market.");
      return;
    }

    try {
      setPhase("validating");
      const report = await forge.validateAgentKit({
        rootPath: kitPath,
        profile: validationProfile,
      });
      setValidationReport(report);
      if (!report.valid) {
        setPhase("failed");
        setError("Validation failed. Fix the reported issues before submitting to Market.");
        return;
      }

      let restoredSettings: PublicSettings;
      try {
        restoredSettings = await forge.restoreAgentKitProjectAccount();
        onSettingsChange(restoredSettings);
      } catch (caughtError) {
        const message = errorToMessage(caughtError);
        const reconnectMessage = submitReconnectRequiredMessage();
        setPhase("failed");
        onAccountReconnectRequired(reconnectMessage);
        setError(`Unable to verify AgentKitProject session before Market submission: ${message}`);
        return;
      }

      if (restoredSettings.accountConnection.accountConnectionStatus !== "connected") {
        const reconnectMessage = submitReconnectRequiredMessage();
        setPhase("failed");
        onAccountReconnectRequired(reconnectMessage);
        setError(reconnectMessage);
        return;
      }

      setPhase("packaging");
      await waitForUiProgress();
      setPhase("uploading");
      const submitPromise = forge.submitHostedMarketKit({
          rootPath: kitPath,
          marketBaseUrl: agentKitProjectUrls.market,
          validationProfile,
        });
      await waitForUiProgress();
      setPhase("creating");
      const submission = await submitPromise;
      setValidationReport(submission.validationReport);
      setResult(submission);
      setPhase("submitted");
    } catch (caughtError) {
      const message = errorToMessage(caughtError);
      setPhase("failed");
      if (isReconnectRequiredError(message)) {
        const reconnectMessage = submitReconnectRequiredMessage();
        onAccountReconnectRequired(reconnectMessage);
        setError(reconnectMessage);
      } else if (isDuplicateVersionError(message)) {
        const currentRaw = String(selectedKit?.version ?? "").trim().replace(/^v/i, "");
        const currentNumber = Number.parseInt(currentRaw, 10);
        const current = formatDisplayVersion(selectedKit?.version) || "this version";
        const next = Number.isFinite(currentNumber) ? `v${currentNumber + 1}` : "the next version";
        setDuplicateVersion({ current, next });
      } else {
        setError(message);
      }
    }
  }

  async function bumpVersionAndResubmit() {
    setError(null);
    setIsBumpingVersion(true);
    try {
      await forge.nextAgentKitVersion(kitPath);
      await refreshMyKits();
    } catch (caughtError) {
      setIsBumpingVersion(false);
      setPhase("failed");
      setError(`Unable to bump the kit version: ${errorToMessage(caughtError)}`);
      return;
    }
    setIsBumpingVersion(false);
    await submitToHostedMarket();
  }

  return (
    <div className="build-layout">
      <div className="form-panel" data-testid="market-submit-panel">
        <div className="provider-card-header">
          <div>
            <h2>Submit to Market</h2>
            <p className="form-copy">Validate and package a local kit, then create a hosted AgentKitMarket submission for admin review.</p>
          </div>
          <span className="provider-badge">Review required</span>
        </div>

        <dl className="report-meta">
          <div>
            <dt>Hosted Market</dt>
            <dd>{agentKitProjectUrls.market}</dd>
          </div>
          <div>
            <dt>AgentKitProject account</dt>
            <dd>{isConnected ? "Connected" : "Required for hosted submission"}</dd>
          </div>
          <div>
            <dt>Publishing</dt>
            <dd>Admin approval required</dd>
          </div>
        </dl>

        <LabelWithHelp htmlFor="market-submit-kit-folder" label="Agent Kit" help="Choose a kit from My Kits. Forge validates and packages it before uploading." />
        <select
          disabled={isSubmitting}
          id="market-submit-kit-folder"
          onChange={(event) => {
            setKitPath(event.target.value);
            onKitPathChange(event.target.value);
            setValidationReport(null);
            setResult(null);
            setError(null);
            setDuplicateVersion(null);
            setPhase("idle");
          }}
          value={kitPath}
        >
          <option value="">Choose from My Kits</option>
          {myKits.map((kit) => (
            <option key={kit.path} value={kit.path}>{kit.name} ({formatDisplayVersion(kit.version)})</option>
          ))}
          {kitPath && !myKits.some((kit) => pathsEqualLoose(kit.path, kitPath)) && (
            <option value={kitPath}>{friendlyLocation(kitPath)}</option>
          )}
        </select>
        {selectedKit && <SelectedKitSummaryCard kit={selectedKit} />}

        <LabelWithHelp htmlFor="market-submit-validation-profile" label="Validation level" help="Publishable validation is recommended before Market submission." />
        <select
          disabled={isSubmitting}
          id="market-submit-validation-profile"
          onChange={(event) => setValidationProfile(event.target.value as ValidationProfile)}
          value={validationProfile}
        >
          {validationProfiles.map((profile) => (
            <option key={profile} value={profile}>
              {profile}
            </option>
          ))}
        </select>

        <div className="inline-warning">
          Forge uploads using your AgentKitProject user session. Publishing is not automatic; Market validation and admin review remain authoritative.
        </div>

        {!isConnected && (
          <div className="inline-warning">
            Connect AgentKitProject account to submit directly to hosted AgentKitMarket.
          </div>
        )}

        <div className="button-row">
          {hostedSubmitConnection && canUseMarketSubmit(hostedSubmitConnection) ? (
            <button className="primary-button" disabled={isSubmitting || isBumpingVersion} onClick={submitToHostedMarket} type="button">
              <UploadCloud size={18} />
              {(isSubmitting || isBumpingVersion) && <InlineSpinner className="button-spinner" />}
              {isSubmitting || isBumpingVersion ? "Submitting..." : "Submit to Market"}
            </button>
          ) : (
            <button className="secondary-button" onClick={onOpenAccount} type="button">
              Connect AgentKitProject account
            </button>
          )}
          <button className="secondary-button" onClick={onOpenMyKits} type="button">
            Open My Kits
          </button>
        </div>
      </div>

      <div className="results-panel">
        <div className="panel-label">Submission</div>
        {phase !== "idle" && (
          <dl className="report-meta" data-testid="market-submit-progress">
            <div>
              <dt>Validating</dt>
              <dd>{submitPhaseStatus(phase, "validating")}</dd>
            </div>
            <div>
              <dt>Packaging</dt>
              <dd>{submitPhaseStatus(phase, "packaging")}</dd>
            </div>
            <div>
              <dt>Uploading</dt>
              <dd>{submitPhaseStatus(phase, "uploading")}</dd>
            </div>
            <div>
              <dt>Creating submission</dt>
              <dd>{submitPhaseStatus(phase, "creating")}</dd>
            </div>
            <div>
              <dt>Review queue</dt>
              <dd>{phase === "submitted" ? "Submitted for admin review" : phase === "failed" ? "Not submitted" : "Waiting"}</dd>
            </div>
          </dl>
        )}
        {error && (
          <div className="error-state" role="alert">
            {error}
          </div>
        )}
        {duplicateVersion && (
          <div className="inline-warning" data-testid="market-submit-duplicate-version" role="alert">
            <p>
              Version {duplicateVersion.current} was already submitted to Market for this kit. You can submit this kit as
              the next version — Forge updates the version for you.
            </p>
            <button
              className="primary-button"
              disabled={isSubmitting || isBumpingVersion}
              onClick={() => void bumpVersionAndResubmit()}
              type="button"
            >
              <UploadCloud size={18} />
              {(isSubmitting || isBumpingVersion) && <InlineSpinner className="button-spinner" />}
              {isSubmitting || isBumpingVersion ? "Submitting..." : `Submit as ${duplicateVersion.next}`}
            </button>
          </div>
        )}
        {result && (
          <div className="artifact-results" data-testid="market-submit-result">
            <div className="copy-state">Submission created. Market admin approval is still required before publishing.</div>
            <dl className="report-meta">
              <div>
                <dt>Submission ID</dt>
                <dd>{result.submissionId}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{formatMarketSubmissionStatus(result.status)}</dd>
              </div>
              <div>
                <dt>Package checksum</dt>
                <dd>{result.packageSha256}</dd>
              </div>
              <div>
                <dt>Market link</dt>
                <dd>{result.marketLink}</dd>
              </div>
            </dl>
            <button className="secondary-button compact-button" onClick={() => openDocsLink(result.marketLink)} type="button">
              Open Market submission
            </button>
          </div>
        )}
        <ValidationResults error={null} isLoading={phase === "validating"} report={validationReport} />
      </div>
    </div>
  );
}

function InstallTargetsScreen({
  currentKitPath,
  onKitPathChange,
}: {
  currentKitPath: string;
  onKitPathChange: (path: string) => void;
}) {
  const [kitPath, setKitPath] = useState(currentKitPath);
  const [activeInstallTarget, setActiveInstallTarget] = useState<InstallTargetTab>("codex");
  const [myKits, setMyKits] = useState<MyKitEntry[]>([]);
  const [destinationSkillsDir, setDestinationSkillsDir] = useState(() =>
    window.localStorage.getItem("agentkitforge.codexSkillsDestination") ?? "",
  );
  const [force, setForce] = useState(false);
  const [claudeDestinationDir, setClaudeDestinationDir] = useState(() =>
    window.localStorage.getItem("agentkitforge.claudeCodeDestination") ?? "",
  );
  const [claudeForce, setClaudeForce] = useState(false);
  const [validateBeforeInstall, setValidateBeforeInstall] = useState(true);
  const [validationProfile, setValidationProfile] = useState<ValidationProfile>("local-valid");
  const [installValidationReport, setInstallValidationReport] = useState<ValidationReport | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ kitPath?: string; destinationSkillsDir?: string }>({});
  const [claudeFieldErrors, setClaudeFieldErrors] = useState<{ kitPath?: string; destinationDir?: string }>({});
  const [result, setResult] = useState<CodexExportResult | null>(null);
  const [claudeResult, setClaudeResult] = useState<ClaudeCodeExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claudeError, setClaudeError] = useState<string | null>(null);
  const [isSelectingKit, setIsSelectingKit] = useState(false);
  const [isSelectingDestination, setIsSelectingDestination] = useState(false);
  const [isSelectingClaudeDestination, setIsSelectingClaudeDestination] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isExportingClaude, setIsExportingClaude] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [claudeCopyState, setClaudeCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const selectedKit = myKits.find((kit) => pathsEqualLoose(kit.path, kitPath));

  useEffect(() => {
    setKitPath(currentKitPath);
  }, [currentKitPath]);

  useEffect(() => {
    forge.listMyKits()
      .then((kits) => {
        const availableKits = kits.filter((kit) => kit.pathExists);
        setMyKits(availableKits);
        if (!kitPath && availableKits.length > 0) {
          setKitPath(availableKits[0].path);
          onKitPathChange(availableKits[0].path);
        }
      })
      .catch(() => setMyKits([]));
  }, []);

  async function selectKitFolder() {
    setIsSelectingKit(true);
    setError(null);

    try {
      const selectedPath = await forge.selectAgentKitFolder();
      if (selectedPath) {
        setKitPath(selectedPath);
        onKitPathChange(selectedPath);
        setResult(null);
        setClaudeResult(null);
      }
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    } finally {
      setIsSelectingKit(false);
    }
  }

  async function selectDestinationFolder() {
    setIsSelectingDestination(true);
    setError(null);

    try {
      const selectedPath = await forge.selectAgentKitFolder();
      if (selectedPath) {
        setDestinationSkillsDir(selectedPath);
        window.localStorage.setItem("agentkitforge.codexSkillsDestination", selectedPath);
        setResult(null);
      }
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    } finally {
      setIsSelectingDestination(false);
    }
  }

  async function selectClaudeDestinationFolder() {
    setIsSelectingClaudeDestination(true);
    setClaudeError(null);

    try {
      const selectedPath = await forge.selectAgentKitFolder();
      if (selectedPath) {
        setClaudeDestinationDir(selectedPath);
        window.localStorage.setItem("agentkitforge.claudeCodeDestination", selectedPath);
        setClaudeResult(null);
      }
    } catch (caughtError) {
      setClaudeError(errorToMessage(caughtError));
    } finally {
      setIsSelectingClaudeDestination(false);
    }
  }

  async function exportToCodex() {
    const validationErrors = validateCodexExportForm(kitPath, destinationSkillsDir);
    setFieldErrors(validationErrors);
    setError(null);
    setResult(null);
    setInstallValidationReport(null);
    setCopyState("idle");

    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setIsExporting(true);

    try {
      if (validateBeforeInstall) {
        await validateForInstall();
      }
      const exportResult = await forge.exportAgentKitToCodex({ kitPath, destinationSkillsDir, force });
      window.localStorage.setItem("agentkitforge.codexSkillsDestination", destinationSkillsDir);
      setResult(exportResult);
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    } finally {
      setIsExporting(false);
    }
  }

  async function exportToClaudeCode() {
    const validationErrors = validateClaudeCodeExportForm(kitPath, claudeDestinationDir);
    setClaudeFieldErrors(validationErrors);
    setClaudeError(null);
    setClaudeResult(null);
    setInstallValidationReport(null);
    setClaudeCopyState("idle");

    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setIsExportingClaude(true);

    try {
      if (validateBeforeInstall) {
        await validateForInstall();
      }
      const exportResult = await forge.exportAgentKitToClaudeCode({ kitPath, destinationDir: claudeDestinationDir, force: claudeForce });
      window.localStorage.setItem("agentkitforge.claudeCodeDestination", claudeDestinationDir);
      setClaudeResult(exportResult);
    } catch (caughtError) {
      setClaudeError(errorToMessage(caughtError));
    } finally {
      setIsExportingClaude(false);
    }
  }

  async function validateForInstall() {
    const report = await forge.validateAgentKit({
      rootPath: kitPath,
      profile: validationProfile,
    });
    setInstallValidationReport(report);
    if (!report.valid) {
      throw new Error("Validation found issues. Fix them before installing, or turn off validation if you intentionally want to continue.");
    }
  }

  async function openDestinationFolder() {
    try {
      await forge.openFolder(result?.destinationSkillsDir ?? destinationSkillsDir);
    } catch (caughtError) {
      setError(errorToMessage(caughtError));
    }
  }

  async function openClaudeDestinationFolder() {
    try {
      await forge.openFolder(claudeResult?.destinationDir ?? claudeDestinationDir);
    } catch (caughtError) {
      setClaudeError(errorToMessage(caughtError));
    }
  }

  async function copyDestinationPath() {
    const path = result?.destinationSkillsDir ?? destinationSkillsDir;
    try {
      await navigator.clipboard.writeText(path);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  async function copyClaudeDestinationPath() {
    const path = claudeResult?.destinationDir ?? claudeDestinationDir;
    try {
      await navigator.clipboard.writeText(path);
      setClaudeCopyState("copied");
    } catch {
      setClaudeCopyState("failed");
    }
  }

  return (
    <div className="install-targets-screen">
      <section className="form-panel">
        <h2>Install on Local Agent</h2>
        <p className="form-copy">
          Export Agent Kits into local agent tools like Codex or Claude Code. AgentKitForge copies files into
          the target tool folder; it does not launch or verify the external tool.
        </p>
        <div className="tab-list install-target-tabs" role="tablist" aria-label="Install target">
          <button
            aria-selected={activeInstallTarget === "codex"}
            className={`tab-button ${activeInstallTarget === "codex" ? "active" : ""}`}
            onClick={() => setActiveInstallTarget("codex")}
            role="tab"
            type="button"
          >
            Codex
          </button>
          <button
            aria-selected={activeInstallTarget === "claude-code"}
            className={`tab-button ${activeInstallTarget === "claude-code" ? "active" : ""}`}
            onClick={() => setActiveInstallTarget("claude-code")}
            role="tab"
            type="button"
          >
            Claude Code
          </button>
        </div>
      </section>

      {activeInstallTarget === "codex" && (
      <div className="build-layout">
        <div className="form-panel">
          <h2>Export to Codex</h2>
          <p className="form-copy">
            Export this kit's skills into a Codex skills folder so Codex can discover them.
          </p>
          <p className="form-copy">
            AgentKitForge does not launch Codex or verify Codex loaded the skills.
          </p>

          <LabelWithHelp htmlFor="codex-kit-folder" label="Agent Kit" help="Choose from My Kits first. Add an existing kit only if it is not in your library yet." />
          <div className="path-picker">
            <select
              id="codex-kit-folder"
              onChange={(event) => {
                const nextPath = event.target.value;
                setKitPath(nextPath);
                onKitPathChange(nextPath);
                setResult(null);
                setClaudeResult(null);
              }}
              value={kitPath}
            >
              <option value="">Choose from My Kits</option>
              {myKits.map((kit) => (
                <option key={kit.path} value={kit.path}>{kit.name} ({formatDisplayVersion(kit.version)})</option>
              ))}
              {kitPath && !myKits.some((kit) => pathsEqualLoose(kit.path, kitPath)) && (
                <option value={kitPath}>{friendlyLocation(kitPath)}</option>
              )}
            </select>
            <button className="icon-button" disabled={isSelectingKit || isExporting || isExportingClaude} onClick={selectKitFolder} title="Select kit folder" type="button">
              <FolderOpen size={18} />
            </button>
          </div>
          <button className="secondary-button compact-button" disabled={isSelectingKit || isExporting || isExportingClaude} onClick={selectKitFolder} type="button">
            Add existing kit...
          </button>
          <FieldError message={fieldErrors.kitPath} />
          {selectedKit && <SelectedKitSummaryCard kit={selectedKit} />}

          <LabelWithHelp htmlFor="codex-destination" label="Codex destination" help="Choose the skills folder Codex reads from. This can differ by operating system and local setup." />
          <div className="friendly-location-row">
            <span>Destination: {destinationSkillsDir ? "Codex skills folder" : "Choose Codex skills folder"}</span>
            <button className="secondary-button compact-button" disabled={isSelectingDestination || isExporting} onClick={selectDestinationFolder} type="button">
              {destinationSkillsDir ? "Choose custom location" : "Choose once"}
            </button>
          </div>
          <details className="advanced-details">
            <summary>Show full destination path</summary>
            <input
              id="codex-destination"
              onChange={(event) => {
                setDestinationSkillsDir(event.target.value);
                setResult(null);
              }}
              placeholder="Full Codex skills folder path"
              value={destinationSkillsDir}
            />
          </details>
          <FieldError message={fieldErrors.destinationSkillsDir} />

          <label className="checkbox-row" htmlFor="codex-force">
            <input
              checked={force}
              id="codex-force"
              onChange={(event) => setForce(event.target.checked)}
              type="checkbox"
            />
            <span>Force overwrite AgentKitForge-generated folders</span>
          </label>

          <InstallValidationControls
            profile={validationProfile}
            validateBeforeInstall={validateBeforeInstall}
            onProfileChange={setValidationProfile}
            onValidateBeforeInstallChange={setValidateBeforeInstall}
          />

          <button className="primary-button" disabled={isExporting} onClick={exportToCodex} type="button">
            <Plug size={18} />
            {isExporting && <InlineSpinner className="button-spinner" />}
            {isExporting ? "Exporting" : "Export/Install to Codex"}
          </button>
        </div>

        <div className="results-panel">
          <div className="panel-label">Codex Export Result</div>
          <CodexExportResults
            copyState={copyState}
            error={error}
            isLoading={isExporting}
            onCopyDestinationPath={copyDestinationPath}
            onOpenDestinationFolder={openDestinationFolder}
            result={result}
            selectedKitName={selectedKit?.name}
            validationReport={installValidationReport}
          />
        </div>
      </div>
      )}

      {activeInstallTarget === "claude-code" && (
      <div className="build-layout">
        <div className="form-panel">
          <h2>Export to Claude Code</h2>
          <p className="form-copy">
            Export this kit as a Claude Code plugin-style folder.
          </p>
          <p className="form-copy">
            AgentKitForge does not launch Claude Code or verify Claude Code loaded the plugin.
            This is an initial adapter; verify plugin loading behavior in Claude Code.
          </p>

          <LabelWithHelp htmlFor="claude-kit-folder" label="Agent Kit" help="Choose from My Kits first. Add an existing kit only if it is not in your library yet." />
          <div className="path-picker">
            <select
              id="claude-kit-folder"
              onChange={(event) => {
                const nextPath = event.target.value;
                setKitPath(nextPath);
                onKitPathChange(nextPath);
                setResult(null);
                setClaudeResult(null);
              }}
              value={kitPath}
            >
              <option value="">Choose from My Kits</option>
              {myKits.map((kit) => (
                <option key={kit.path} value={kit.path}>{kit.name} ({formatDisplayVersion(kit.version)})</option>
              ))}
              {kitPath && !myKits.some((kit) => pathsEqualLoose(kit.path, kitPath)) && (
                <option value={kitPath}>{friendlyLocation(kitPath)}</option>
              )}
            </select>
            <button className="icon-button" disabled={isSelectingKit || isExporting || isExportingClaude} onClick={selectKitFolder} title="Select kit folder" type="button">
              <FolderOpen size={18} />
            </button>
          </div>
          <button className="secondary-button compact-button" disabled={isSelectingKit || isExporting || isExportingClaude} onClick={selectKitFolder} type="button">
            Add existing kit...
          </button>
          <FieldError message={claudeFieldErrors.kitPath} />
          {selectedKit && <SelectedKitSummaryCard kit={selectedKit} />}

          <LabelWithHelp htmlFor="claude-destination" label="Claude Code destination" help="Choose the plugins folder Claude Code reads from. This can differ by operating system and local setup." />
          <div className="friendly-location-row">
            <span>Destination: {claudeDestinationDir ? "Claude Code plugins folder" : "Choose Claude Code plugins folder"}</span>
            <button className="secondary-button compact-button" disabled={isSelectingClaudeDestination || isExportingClaude} onClick={selectClaudeDestinationFolder} type="button">
              {claudeDestinationDir ? "Choose custom location" : "Choose once"}
            </button>
          </div>
          <details className="advanced-details">
            <summary>Show full destination path</summary>
            <input
              id="claude-destination"
              onChange={(event) => {
                setClaudeDestinationDir(event.target.value);
                setClaudeResult(null);
              }}
              placeholder="Full Claude Code plugins folder path"
              value={claudeDestinationDir}
            />
          </details>
          <FieldError message={claudeFieldErrors.destinationDir} />

          <label className="checkbox-row" htmlFor="claude-force">
            <input
              checked={claudeForce}
              id="claude-force"
              onChange={(event) => setClaudeForce(event.target.checked)}
              type="checkbox"
            />
            <span>Force overwrite AgentKitForge-generated plugin folder</span>
          </label>

          <InstallValidationControls
            profile={validationProfile}
            validateBeforeInstall={validateBeforeInstall}
            onProfileChange={setValidationProfile}
            onValidateBeforeInstallChange={setValidateBeforeInstall}
          />

          <button className="primary-button" disabled={isExportingClaude} onClick={exportToClaudeCode} type="button">
            <Plug size={18} />
            {isExportingClaude && <InlineSpinner className="button-spinner" />}
            {isExportingClaude ? "Exporting" : "Export/Install to Claude Code"}
          </button>
        </div>

        <div className="results-panel">
          <div className="panel-label">Claude Code Export Result</div>
          <ClaudeCodeExportResults
            copyState={claudeCopyState}
            error={claudeError}
            isLoading={isExportingClaude}
            onCopyDestinationPath={copyClaudeDestinationPath}
            onOpenDestinationFolder={openClaudeDestinationFolder}
            result={claudeResult}
            selectedKitName={selectedKit?.name}
            validationReport={installValidationReport}
          />
        </div>
      </div>
      )}
    </div>
  );
}

function CodexExportResults({
  copyState,
  error,
  isLoading,
  onCopyDestinationPath,
  onOpenDestinationFolder,
  result,
  selectedKitName,
  validationReport,
}: {
  copyState: "idle" | "copied" | "failed";
  error: string | null;
  isLoading: boolean;
  onCopyDestinationPath: () => void;
  onOpenDestinationFolder: () => void;
  result: CodexExportResult | null;
  selectedKitName?: string;
  validationReport: ValidationReport | null;
}) {
  if (isLoading) {
    return <LoadingStatus text="Validating kit and exporting to Codex..." />;
  }

  if (error && !result) {
    return (
      <div className="error-state" role="alert">
        {error}
      </div>
    );
  }

  if (!result) {
    return (
      <>
        {validationReport && <ValidationResults error={null} isLoading={false} report={validationReport} />}
        <p className="state-copy">Export a kit to see Codex skill folders here.</p>
      </>
    );
  }

  return (
    <div className="artifact-results">
      <div className="status-banner valid">
        <strong>Exported</strong>
        <span>{result.exportedSkillFolders.length} skill folder{result.exportedSkillFolders.length === 1 ? "" : "s"}</span>
      </div>
      {validationReport && <ValidationResults error={null} isLoading={false} report={validationReport} />}

      <dl className="report-meta">
        <div>
          <dt>Target</dt>
          <dd>Codex</dd>
        </div>
        <div>
          <dt>Selected kit</dt>
          <dd>{selectedKitName || "Selected kit"}</dd>
        </div>
        <div>
          <dt>Destination</dt>
          <dd>Codex skills folder</dd>
        </div>
        <div>
          <dt>Generated index folder</dt>
          <dd>{result.generatedIndexFolder ? friendlyLocation(result.generatedIndexFolder) : "None"}</dd>
        </div>
      </dl>
      <details className="advanced-details">
        <summary>Show full paths</summary>
        <dl className="report-meta">
          <div>
            <dt>Destination skills directory</dt>
            <dd>{result.destinationSkillsDir}</dd>
          </div>
          <div>
            <dt>Generated index folder</dt>
            <dd>{result.generatedIndexFolder || "None"}</dd>
          </div>
        </dl>
      </details>

      {result.warnings.length > 0 && (
        <div className="inline-warning">
          {result.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      )}

      <div className="button-row">
        <button className="secondary-button compact-button" onClick={onOpenDestinationFolder} type="button">
          Open destination folder
        </button>
        <button className="secondary-button compact-button" onClick={onCopyDestinationPath} type="button">
          Copy destination path
        </button>
      </div>
      {copyState === "copied" && <div className="copy-state">Destination path copied.</div>}
      {copyState === "failed" && <div className="field-error">Clipboard access failed.</div>}

      <div className="created-files">
        <h3>Exported skill folders</h3>
        <ul>
          {result.exportedSkillFolders.map((folder) => (
            <li key={folder}>{folder}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function InstallValidationControls({
  onProfileChange,
  onValidateBeforeInstallChange,
  profile,
  validateBeforeInstall,
}: {
  onProfileChange: (profile: ValidationProfile) => void;
  onValidateBeforeInstallChange: (value: boolean) => void;
  profile: ValidationProfile;
  validateBeforeInstall: boolean;
}) {
  return (
    <div className="advanced-details">
      <label className="checkbox-row" htmlFor="install-validate-before-export">
        <input
          checked={validateBeforeInstall}
          id="install-validate-before-export"
          onChange={(event) => onValidateBeforeInstallChange(event.target.checked)}
          type="checkbox"
        />
        <span>Validate before installing</span>
        <HelpTip text="Checks the kit before copying it into an external tool folder." />
      </label>
      <LabelWithHelp htmlFor="install-validation-profile" label="Validation level" help="Choose how strict the pre-install check should be." />
      <select
        disabled={!validateBeforeInstall}
        id="install-validation-profile"
        onChange={(event) => onProfileChange(event.target.value as ValidationProfile)}
        value={profile}
      >
        {validationProfiles.map((validationProfile) => (
          <option key={validationProfile} value={validationProfile}>
            {validationProfile}
          </option>
        ))}
      </select>
    </div>
  );
}

function ClaudeCodeExportResults({
  copyState,
  error,
  isLoading,
  onCopyDestinationPath,
  onOpenDestinationFolder,
  result,
  selectedKitName,
  validationReport,
}: {
  copyState: "idle" | "copied" | "failed";
  error: string | null;
  isLoading: boolean;
  onCopyDestinationPath: () => void;
  onOpenDestinationFolder: () => void;
  result: ClaudeCodeExportResult | null;
  selectedKitName?: string;
  validationReport: ValidationReport | null;
}) {
  if (isLoading) {
    return <LoadingStatus text="Validating kit and exporting to Claude Code..." />;
  }

  if (error && !result) {
    return (
      <div className="error-state" role="alert">
        {error}
      </div>
    );
  }

  if (!result) {
    return (
      <>
        {validationReport && <ValidationResults error={null} isLoading={false} report={validationReport} />}
        <p className="state-copy">Export a kit to see Claude Code plugin files here.</p>
      </>
    );
  }

  return (
    <div className="artifact-results">
      <div className="status-banner valid">
        <strong>Exported</strong>
        <span>{result.exportedSkillFolders.length} skill folder{result.exportedSkillFolders.length === 1 ? "" : "s"}</span>
      </div>
      {validationReport && <ValidationResults error={null} isLoading={false} report={validationReport} />}

      <dl className="report-meta">
        <div>
          <dt>Target</dt>
          <dd>Claude Code</dd>
        </div>
        <div>
          <dt>Selected kit</dt>
          <dd>{selectedKitName || "Selected kit"}</dd>
        </div>
        <div>
          <dt>Destination</dt>
          <dd>Claude Code plugins folder</dd>
        </div>
        <div>
          <dt>Generated plugin folder</dt>
          <dd>{friendlyLocation(result.pluginFolder)}</dd>
        </div>
      </dl>
      <details className="advanced-details">
        <summary>Show full paths</summary>
        <dl className="report-meta">
          <div>
            <dt>Destination directory</dt>
            <dd>{result.destinationDir}</dd>
          </div>
          <div>
            <dt>Plugin manifest path</dt>
            <dd>{result.pluginManifestPath}</dd>
          </div>
        </dl>
      </details>

      {result.warnings.length > 0 && (
        <div className="inline-warning">
          {result.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      )}

      <div className="button-row">
        <button className="secondary-button compact-button" onClick={onOpenDestinationFolder} type="button">
          Open destination folder
        </button>
        <button className="secondary-button compact-button" onClick={onCopyDestinationPath} type="button">
          Copy destination path
        </button>
      </div>
      {copyState === "copied" && <div className="copy-state">Destination path copied.</div>}
      {copyState === "failed" && <div className="field-error">Clipboard access failed.</div>}

      <div className="created-files">
        <h3>Exported skill folders</h3>
        <ul>
          {result.exportedSkillFolders.map((folder) => (
            <li key={folder}>{folder}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function PackageExportResults({
  artifacts,
  copyState,
  error,
  isLoading,
  onCopyArtifactPath,
  onOpenOutputFolder,
  outputFolder,
  validationReport,
}: {
  artifacts: ArtifactResult[];
  copyState: string | null;
  error: string | null;
  isLoading: boolean;
  onCopyArtifactPath: (artifactPath: string) => void;
  onOpenOutputFolder: () => void;
  outputFolder: string;
  validationReport: ValidationReport | null;
}) {
  if (isLoading && artifacts.length === 0 && !error) {
    return <LoadingStatus text="Creating export artifact..." />;
  }

  return (
    <div className="artifact-results">
      {error && (
        <div className="error-state" role="alert">
          {error}
        </div>
      )}

      {validationReport && (
        <div className={`status-banner ${validationReport.valid ? "valid" : "invalid"}`}>
          <strong>{validationReport.valid ? "Validation passed" : "Validation failed"}</strong>
          <span>{validationReport.profile}</span>
        </div>
      )}

      {artifacts.length === 0 ? (
        <p className="state-copy">
          Package an Agent Kit as a distributable zip or export a one-file Markdown bundle.
        </p>
      ) : (
        <>
          <button className="secondary-button compact-button" onClick={onOpenOutputFolder} type="button">
            Open output folder
          </button>
          <div className="artifact-list">
            {artifacts.map((artifact) => (
              <article className="artifact-item" key={`${artifact.artifactType}-${artifact.artifactPath}`}>
                <div>
                  <div className="issue-code">{artifact.artifactType}</div>
                  <p>{friendlyFileName(artifact.artifactPath)}</p>
                  <small>{isDefaultExportsFolder(outputFolder) ? "AgentKitForge Exports" : friendlyLocation(outputFolder)}</small>
                  {copyState === artifact.artifactPath && (
                    <div className="copy-state">Artifact path copied.</div>
                  )}
                  <details className="advanced-details">
                    <summary>Show full path</summary>
                    <p className="inline-code">{artifact.artifactPath}</p>
                  </details>
                </div>
                <button
                  className="secondary-button compact-button"
                  onClick={() => onCopyArtifactPath(artifact.artifactPath)}
                  type="button"
                >
                  Copy path
                </button>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ForgeRunResults({
  copyState,
  documentLikeOutput,
  error,
  isLoading,
  isSavingResponse,
  onCopyResult,
  onClearResult,
  onSaveResult,
  onSaveResultText,
  preRunValidationReport,
  result,
  runCompletedAt,
  savedResponsePath,
  selectedContextMode,
  promptMode,
  preparedPromptName,
  selectedKitName,
  selectedKitPath,
  validationProfile,
}: {
  copyState: "idle" | "copied" | "failed";
  documentLikeOutput: boolean;
  error: string | null;
  isLoading: boolean;
  isSavingResponse: boolean;
  onCopyResult: () => void;
  onClearResult: () => void;
  onSaveResult: () => void;
  onSaveResultText: () => void;
  preRunValidationReport: ValidationReport | null;
  result: RunAgentKitResult | null;
  runCompletedAt: string | null;
  savedResponsePath: string | null;
  selectedContextMode: AgentKitContextMode;
  promptMode: UsePromptMode;
  preparedPromptName?: string;
  selectedKitName?: string;
  selectedKitPath: string;
  validationProfile: ValidationProfile;
}) {
  if (isLoading) {
    return <LoadingStatus text="Validating kit, building context, and waiting for provider response..." />;
  }

  if (error && !result) {
    return (
      <div className="forge-result">
        <div className="error-state" role="alert">
          {error}
        </div>
        {preRunValidationReport && (
          <ValidationResults error={null} isLoading={false} report={preRunValidationReport} />
        )}
      </div>
    );
  }

  if (!result) {
    return (
      <p className="state-copy">
        Select a kit, describe the task, and run it inside Forge. Triggered context uses matching
        skills first and shows a warning if it falls back.
      </p>
    );
  }

  return (
    <div className="forge-result">
      <div className="status-banner valid">
        <strong>Complete</strong>
        <span>{result.providerName} · {result.model}</span>
      </div>

      <div className="panel-heading">
        <h3>Response</h3>
        <div className="button-row">
          <button className="secondary-button compact-button" onClick={onCopyResult} type="button">
            Copy response
          </button>
          <button
            className={`${documentLikeOutput ? "primary-button" : "secondary-button"} compact-button`}
            disabled={isSavingResponse}
            onClick={onSaveResult}
            type="button"
          >
            {isSavingResponse && <InlineSpinner className="button-spinner" />}
            {isSavingResponse ? "Saving" : "Download as Markdown"}
          </button>
          <button
            className="secondary-button compact-button"
            disabled={isSavingResponse}
            onClick={onSaveResultText}
            type="button"
          >
            {isSavingResponse && <InlineSpinner className="button-spinner" />}
            Download as Text
          </button>
          <button className="secondary-button compact-button" onClick={onClearResult} type="button">
            Clear
          </button>
        </div>
      </div>

      <div className="assistant-response">{result.response}</div>
      {copyState === "copied" && <div className="copy-state">Copied to clipboard.</div>}
      {copyState === "failed" && (
        <div className="field-error">Clipboard access failed. Select and copy the result text.</div>
      )}
      {savedResponsePath && <div className="copy-state">Saved to {savedResponsePath}</div>}
      {error && (
        <div className="error-state" role="alert">
          {error}
        </div>
      )}

      <RunMetadata
        result={result}
        runCompletedAt={runCompletedAt}
        selectedContextMode={selectedContextMode}
        promptMode={promptMode}
        preparedPromptName={preparedPromptName}
        selectedKitName={selectedKitName}
        selectedKitPath={selectedKitPath}
        validationProfile={validationProfile}
      />

      <details className="context-details">
        <summary>Context details</summary>
        <dl className="report-meta">
          <div>
            <dt>Approx. context length</dt>
            <dd>{result.context.approximateContextLength.toLocaleString()} characters</dd>
          </div>
          <div>
            <dt>Included skills</dt>
            <dd>{result.context.includedSkills.length > 0 ? result.context.includedSkills.join(", ") : "None"}</dd>
          </div>
        </dl>

        {result.context.warnings.length > 0 && (
          <div className="inline-warning">
            {result.context.warnings.map((warning) => (
              <div key={warning}>{warning}</div>
            ))}
          </div>
        )}

        <div className="created-files">
          <h3>Included files</h3>
          <ul>
            {result.context.includedFiles.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}

function StarterHintPanel({
  error,
  hint,
  isLoading,
}: {
  error: string | null;
  hint: AgentKitStarterHint | null;
  isLoading: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  if (isLoading) {
    return <LoadingStatus text="Checking for starter guidance..." />;
  }

  if (error) {
    return null;
  }

  if (!hint) {
    return null;
  }

  async function copyHint() {
    if (!hint) {
      return;
    }
    try {
      await navigator.clipboard.writeText(hint.excerpt);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div className="starter-hint-panel">
      <div className="panel-heading">
        <strong>Starter hint from {hint.sourceFile}</strong>
        <div className="button-row">
          <button className="secondary-button compact-button" onClick={copyHint} type="button">
            Copy
          </button>
          <button className="secondary-button compact-button" onClick={() => setIsExpanded((current) => !current)} type="button">
            {isExpanded ? "Collapse" : "Expand"}
          </button>
        </div>
      </div>
      <div className={`starter-hint-copy ${isExpanded ? "expanded" : ""}`}>{hint.excerpt}</div>
      {copyState === "copied" && <div className="copy-state">Starter hint copied.</div>}
      {copyState === "failed" && <div className="field-error">Clipboard access failed.</div>}
    </div>
  );
}

function UseKitSelector({
  currentKitPath,
  kits,
  onChange,
  selectedKit,
}: {
  currentKitPath: string;
  kits: MyKitEntry[];
  onChange: (path: string) => void;
  selectedKit?: MyKitEntry;
}) {
  return (
    <div className="use-kit-selector">
      <LabelWithHelp
        htmlFor="runtime-kit"
        label="Select Agent Kit"
        help="Choose a kit from My Kits. Import or build a kit first if it is not listed."
      />
      <select id="runtime-kit" onChange={(event) => onChange(event.target.value)} value={currentKitPath}>
        <option value="">Choose from My Kits</option>
        {kits.map((kit) => (
          <option key={kit.path} value={kit.path}>
            {kit.name} ({formatDisplayVersion(kit.version)})
          </option>
        ))}
      </select>
      {selectedKit && (
        <article className="selected-kit-card">
          <div>
            <strong>{selectedKit.name}</strong>
            <span>{selectedKit.version}</span>
          </div>
          <p>{selectedKit.description || "No description available."}</p>
          <small>{friendlyLocation(selectedKit.path)}</small>
        </article>
      )}
    </div>
  );
}

function UsePromptModeSelector({
  disabledPrepared,
  mode,
  onChange,
  promptCount,
}: {
  disabledPrepared: boolean;
  mode: UsePromptMode;
  onChange: (mode: UsePromptMode) => void;
  promptCount: number;
}) {
  return (
    <div className="prompt-mode-control">
      <LabelWithHelp
        htmlFor="prompt-mode"
        label="Prompt type"
        help="Use a prepared prompt when the kit provides one, or write your own prompt anytime."
      />
      <select id="prompt-mode" onChange={(event) => onChange(event.target.value as UsePromptMode)} value={mode}>
        {!disabledPrepared && (
          <option value="prepared">Prepared Prompt</option>
        )}
        <option value="custom">Custom Prompt</option>
      </select>
      {!disabledPrepared && (
        <p className="form-copy compact-state">
          {promptCount} prepared prompt{promptCount === 1 ? "" : "s"} available.
        </p>
      )}
    </div>
  );
}

function RunMetadata({
  preparedPromptName,
  promptMode,
  result,
  runCompletedAt,
  selectedContextMode,
  selectedKitName,
  selectedKitPath,
  validationProfile,
}: {
  preparedPromptName?: string;
  promptMode: UsePromptMode;
  result: RunAgentKitResult;
  runCompletedAt: string | null;
  selectedContextMode: AgentKitContextMode;
  selectedKitName?: string;
  selectedKitPath: string;
  validationProfile: ValidationProfile;
}) {
  return (
    <dl className="report-meta run-meta">
      <div>
        <dt>Kit</dt>
        <dd>{result.kitName || selectedKitName || friendlyLocation(selectedKitPath) || "Selected kit"}</dd>
      </div>
      <div>
        <dt>Provider</dt>
        <dd>{result.providerName}</dd>
      </div>
      <div>
        <dt>Model</dt>
        <dd>{result.model}</dd>
      </div>
      <div>
        <dt>Context mode</dt>
        <dd>{selectedContextMode}</dd>
      </div>
      <div>
        <dt>Prompt mode</dt>
        <dd>{promptMode === "prepared" ? "Prepared Prompt" : "Custom Prompt"}</dd>
      </div>
      {preparedPromptName && (
        <div>
          <dt>Prepared prompt</dt>
          <dd>{preparedPromptName}</dd>
        </div>
      )}
      <div>
        <dt>Validation profile</dt>
        <dd>{validationProfile}</dd>
      </div>
      <div>
        <dt>Included skills</dt>
        <dd>{result.context.includedSkills.length > 0 ? result.context.includedSkills.join(", ") : "None"}</dd>
      </div>
      <div>
        <dt>Included files</dt>
        <dd>{result.context.includedFiles.length}</dd>
      </div>
      <div>
        <dt>Warnings</dt>
        <dd>{result.context.warnings.length}</dd>
      </div>
      <div>
        <dt>Timestamp</dt>
        <dd>{runCompletedAt ? new Date(runCompletedAt).toLocaleString() : "Just now"}</dd>
      </div>
    </dl>
  );
}

function PreparedPromptSelector({
  isLoading,
  onSelectPrompt,
  prompts,
  selectedPromptId,
}: {
  isLoading: boolean;
  onSelectPrompt: (promptId: string) => void;
  prompts: PreparedPrompt[];
  selectedPromptId: string;
}) {
  if (isLoading) {
    return <LoadingStatus text="Loading prepared prompts..." />;
  }

  if (prompts.length === 0) {
    return null;
  }

  const selectedPrompt = prompts.find((prompt) => prompt.id === selectedPromptId) ?? prompts[0];

  return (
    <div className="prepared-prompt-panel">
      <LabelWithHelp
        htmlFor="prepared-prompt"
        label="Prepared Prompt"
        help="Prepared prompts are reusable workflows from the kit. Choose one, fill the fields, preview, then run."
      />
      <select
        id="prepared-prompt"
        onChange={(event) => onSelectPrompt(event.target.value)}
        value={selectedPromptId}
      >
        {prompts.map((prompt) => (
          <option key={prompt.id} value={prompt.id}>
            {prompt.name}
          </option>
        ))}
      </select>
      {selectedPrompt && (
        <div className="selected-prompt-summary">
          <p>{selectedPrompt.description || "No description provided."}</p>
          <small>
            {selectedPrompt.inputs.length} input{selectedPrompt.inputs.length === 1 ? "" : "s"}
            {selectedPrompt.documentLikeOutput ? " · document-like output" : ""}
          </small>
        </div>
      )}
    </div>
  );
}

function PreparedPromptInputFields({
  inputs,
  onChange,
  values,
}: {
  inputs: PreparedPromptInput[];
  onChange: (input: PreparedPromptInput, value: unknown) => void;
  values: Record<string, unknown>;
}) {
  if (inputs.length === 0) {
    return <p className="state-copy compact-state">This prepared prompt does not need additional inputs.</p>;
  }

  return (
    <div className="required-inputs-panel">
      <div className="panel-heading">
        <h3>Required Inputs</h3>
        <HelpTip text="Fill the fields this prepared prompt needs. Required fields must be completed before running." />
      </div>
      {inputs.map((input) => (
        <PreparedPromptInputField
          input={input}
          key={input.id}
          onChange={(value) => onChange(input, value)}
          value={values[input.id] ?? input.defaultValue ?? defaultValueForPromptInput(input)}
        />
      ))}
    </div>
  );
}

function PreparedPromptInputField({
  input,
  onChange,
  value,
}: {
  input: PreparedPromptInput;
  onChange: (value: unknown) => void;
  value: unknown;
}) {
  const label = `${input.label}${input.required ? " *" : ""}`;
  const id = `prompt-input-${input.id}`;

  return (
    <div className="prompt-input-field">
      <LabelWithHelp
        htmlFor={id}
        label={label}
        help={input.description || "This value will be used to render the prepared prompt."}
      />
      {input.type === "long-text" && (
        <textarea
          id={id}
          onChange={(event) => onChange(event.target.value)}
          placeholder={input.placeholder}
          rows={4}
          value={typeof value === "string" ? value : ""}
        />
      )}
      {["short-text", "date"].includes(input.type) && (
        <input
          id={id}
          onChange={(event) => onChange(event.target.value)}
          placeholder={input.placeholder}
          type={input.type === "date" ? "date" : "text"}
          value={typeof value === "string" ? value : ""}
        />
      )}
      {input.type === "number" && (
        <input
          id={id}
          onChange={(event) => onChange(event.target.value)}
          placeholder={input.placeholder}
          type="number"
          value={typeof value === "number" || typeof value === "string" ? value : ""}
        />
      )}
      {input.type === "boolean" && (
        <label className="checkbox-row" htmlFor={id}>
          <input
            checked={value === true}
            id={id}
            onChange={(event) => onChange(event.target.checked)}
            type="checkbox"
          />
          <span>{input.placeholder || "Yes"}</span>
        </label>
      )}
      {input.type === "choice" && (
        <select id={id} onChange={(event) => onChange(event.target.value)} value={typeof value === "string" ? value : ""}>
          <option value="">Choose one</option>
          {(input.choices ?? []).map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      )}
      {input.type === "multi-choice" && (
        <div className="checkbox-grid">
          {(input.choices ?? []).map((choice) => {
            const selected = Array.isArray(value) ? value.includes(choice) : false;
            return (
              <label className="checkbox-row" key={choice}>
                <input
                  checked={selected}
                  onChange={(event) => {
                    const current = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
                    onChange(event.target.checked ? [...current, choice] : current.filter((item) => item !== choice));
                  }}
                  type="checkbox"
                />
                <span>{choice}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PromptPreview({
  additionalContext,
  isRendering,
  mode,
  preparedPrompt,
  renderedPrompt,
  userTask,
}: {
  additionalContext: string;
  isRendering?: boolean;
  mode: UsePromptMode;
  preparedPrompt?: PreparedPrompt;
  renderedPrompt?: string;
  userTask: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const preview = mode === "prepared" && preparedPrompt
    ? renderedPrompt || ""
    : buildPlannedPrompt(userTask, additionalContext);
  async function copyPreview() {
    try {
      await navigator.clipboard.writeText(preview);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }
  return (
    <details className="context-details prompt-preview" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>Prompt Preview</summary>
      <p className="form-copy">
        {mode === "prepared" && preparedPrompt
          ? "This is the prepared prompt after your inputs are filled in."
          : "This is the user-facing request AgentKitForge will combine with the selected kit context."}
      </p>
      <button className="secondary-button compact-button" disabled={!preview} onClick={copyPreview} type="button">
        Copy preview
      </button>
      {isRendering ? (
        <LoadingStatus text="Rendering prompt preview..." />
      ) : (
        <pre className="json-panel">{preview || "Fill required inputs to preview the prompt."}</pre>
      )}
      {copyState === "copied" && <div className="copy-state">Prompt preview copied.</div>}
      {copyState === "failed" && <div className="field-error">Clipboard access failed.</div>}
    </details>
  );
}

function buildPlannedPrompt(
  userTask: string,
  additionalContext: string,
) {
  return [
    userTask.trim() ? `Main task:\n${userTask.trim()}` : "",
    additionalContext.trim() ? `Additional context:\n${additionalContext.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function findUnresolvedPromptVariables(text: string) {
  const matches = text.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g);
  return Array.from(new Set(Array.from(matches, (match) => match[1])));
}

function defaultValueForPromptInput(input: PreparedPromptInput): unknown {
  if (input.defaultValue !== undefined) {
    return input.defaultValue;
  }

  if (input.type === "boolean") {
    return false;
  }

  if (input.type === "multi-choice") {
    return [];
  }

  return "";
}

function defaultPreparedPromptInputs(prompt?: PreparedPrompt) {
  if (!prompt) {
    return {};
  }

  return Object.fromEntries(
    prompt.inputs.map((input) => [input.id, defaultValueForPromptInput(input)]),
  );
}

function pathsEqualLoose(left: string, right: string) {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

function normalizePathForCompare(path: string) {
  return path.trim().replace(/[\\/]+/g, "/").replace(/\/+$/g, "").toLowerCase();
}

function responseDownloadName(prompt: PreparedPrompt | undefined, kitPath: string, extension: "md" | "txt") {
  const baseName = prompt?.suggestedFileName?.trim() || `${slugify(friendlyFileName(kitPath)) || "agent-kit"}-output`;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const withTimestamp = prompt?.suggestedFileName?.trim() ? baseName : `${baseName}-${timestamp}`;
  return withTimestamp.toLowerCase().endsWith(`.${extension}`) ? withTimestamp : `${withTimestamp}.${extension}`;
}

function friendlyFileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function friendlyLocation(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 1) {
    return path;
  }
  return `${parts[parts.length - 2]} / ${parts[parts.length - 1]}`;
}

function friendlyGitRepoLabel(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/^\/+/, "").replace(/\.git$/i, "") || parsed.hostname;
  } catch {
    return url.replace(/\.git$/i, "");
  }
}

function friendlyValidationLabel(value: string) {
  return value.replace(/\\/g, "/");
}

function defaultRequestedBuildSections() {
  return [
    ...requiredBuildSections,
    "policies",
    "templates",
    "examples",
  ];
}

function defaultExcludedBuildSections(requestedSections: string[]) {
  return buildSectionOptions
    .map((section) => section.id)
    .filter((sectionId) => !requestedSections.includes(sectionId));
}

function appKitsFolder(settings: PublicSettings) {
  return settings.defaultOutputFolder || "";
}

function appExportsFolder(settings: PublicSettings) {
  return siblingAppFolder(settings.defaultOutputFolder, "Exports");
}

function siblingAppFolder(basePath: string, folderName: string) {
  if (!basePath.trim()) {
    return "";
  }
  const separator = basePath.includes("\\") ? "\\" : "/";
  const parts = basePath.split(/[\\/]/).filter(Boolean);
  if (parts[parts.length - 1]?.toLowerCase() === "kits") {
    return `${basePath.slice(0, basePath.lastIndexOf(parts[parts.length - 1]))}${folderName}`;
  }
  return `${basePath}${basePath.endsWith("\\") || basePath.endsWith("/") ? "" : separator}${folderName}`;
}

function isDefaultKitsFolder(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() === "kits";
}

function isDefaultExportsFolder(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() === "exports";
}

function openDocsLink(url: string) {
  forge.openExternalUrl(url).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

function OneFileExportResults({
  copyState,
  error,
  isLoading,
  onCopyStarterPrompt,
  result,
}: {
  copyState: "idle" | "copied" | "failed";
  error: string | null;
  isLoading: boolean;
  onCopyStarterPrompt: () => void;
  result: ExportAgentKitResult | null;
}) {
  if (isLoading) {
    return <LoadingStatus text="Exporting one-file Markdown..." />;
  }

  if (error && !result) {
    return (
      <div className="error-state" role="alert">
        {error}
      </div>
    );
  }

  if (!result) {
    return (
      <p className="state-copy">
        Prepare a selected kit for manual use in ChatGPT, Claude, or another web assistant.
        AgentKitForge creates one Markdown file plus a starter prompt; it does not install anything.
        If you choose a folder, AgentKitForge uses the default name
        <span className="inline-code"> &lt;kit-id&gt;-&lt;version&gt;.onefile.md</span>.
      </p>
    );
  }

  return (
    <div className="onefile-result">
      <div className="status-banner valid">
        <strong>Exported</strong>
        <span>Markdown bundle ready</span>
      </div>

      <dl className="report-meta">
        <div>
          <dt>Generated file</dt>
          <dd>{friendlyFileName(result.filePath)}</dd>
        </div>
      </dl>
      <details className="advanced-details">
        <summary>Advanced details</summary>
        <dl className="report-meta">
          <div>
            <dt>Full path</dt>
            <dd>{result.filePath}</dd>
          </div>
        </dl>
      </details>

      <div className="starter-prompt-panel">
        <div className="panel-heading">
          <h3>Starter prompt</h3>
          <button className="secondary-button compact-button" onClick={onCopyStarterPrompt} type="button">
            Copy Starter Prompt
          </button>
        </div>
        <p>{starterPrompt}</p>
        {copyState === "copied" && <div className="copy-state">Copied to clipboard.</div>}
        {copyState === "failed" && (
          <div className="field-error">Clipboard access failed. Select and copy the prompt text.</div>
        )}
      </div>

      <div className="usage-steps">
        <h3>Use with a web assistant</h3>
        <ol>
          <li>Open ChatGPT, Claude, or another AI assistant.</li>
          <li>Upload the generated .md file.</li>
          <li>Upload any task files required by the kit.</li>
          <li>Paste the starter prompt.</li>
          <li>Review the output before relying on it.</li>
        </ol>
      </div>
    </div>
  );
}

function validateExportForm(kitPath: string, outputPath: string) {
  const errors: { kitPath?: string; outputPath?: string } = {};

  if (kitPath.trim() === "") {
    errors.kitPath = "Kit folder is required.";
  }

  if (outputPath.trim() === "") {
    errors.outputPath = "Output file path or output folder is required.";
  }

  return errors;
}

function validatePackageExportForm(kitPath: string, outputFolder: string) {
  const errors: { kitPath?: string; outputFolder?: string } = {};

  if (kitPath.trim() === "") {
    errors.kitPath = "Kit folder is required.";
  }

  if (outputFolder.trim() === "") {
    errors.outputFolder = "Output folder is required.";
  }

  return errors;
}

function validateCodexExportForm(kitPath: string, destinationSkillsDir: string) {
  const errors: { kitPath?: string; destinationSkillsDir?: string } = {};

  if (kitPath.trim() === "") {
    errors.kitPath = "Kit folder is required.";
  }

  if (destinationSkillsDir.trim() === "") {
    errors.destinationSkillsDir = "Codex skills destination folder is required.";
  }

  return errors;
}

function validateClaudeCodeExportForm(kitPath: string, destinationDir: string) {
  const errors: { kitPath?: string; destinationDir?: string } = {};

  if (kitPath.trim() === "") {
    errors.kitPath = "Kit folder is required.";
  }

  if (destinationDir.trim() === "") {
    errors.destinationDir = "Claude Code plugins destination folder is required.";
  }

  return errors;
}

function formatValidationState(kit: MyKitEntry) {
  if (kit.lastValidationValid === undefined || kit.lastValidationValid === null) {
    return "Not validated";
  }

  return `${kit.lastValidationValid ? "Valid" : "Invalid"} (${kit.lastValidatedProfile ?? "unknown"})`;
}

function summaryList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function summaryCount(summary: AgentKitSummary | undefined, key: string, fallback: number) {
  return summary?.counts?.[key] ?? fallback;
}

function summaryItemName(item: Record<string, unknown>, fallback: string) {
  return stringValue(item.name, stringValue(item.id, fallback));
}

function summaryPromptInputCount(item: Record<string, unknown>) {
  return Array.isArray(item.inputs) ? item.inputs.length : 0;
}

function formatTimestamp(value?: string) {
  if (!value) {
    return "Never";
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return value;
  }

  return new Date(numeric * 1000).toLocaleString();
}

function validateRunForm(settings: PublicSettings, providerId: string, kitPath: string, userTask: string) {
  const errors: { apiKey?: string; providerId?: string; kitPath?: string; userTask?: string } = {};

  if (settings.aiProviders.length === 0) {
    errors.apiKey = "AI provider is required. Add one in Settings first.";
  }

  if (providerId.trim() === "") {
    errors.providerId = "AI provider is required.";
  }

  if (kitPath.trim() === "") {
    errors.kitPath = "Kit folder is required.";
  }

  if (userTask.trim() === "") {
    errors.userTask = "Task is required.";
  }

  return errors;
}

function createDefaultGuidedBuilderState(outputFolder: string): GuidedBuilderState {
  return {
    name: "",
    id: "",
    description: "",
    domain: "",
    targetUsers: "",
    validationLevel: "local-valid",
    outputFolder,
    skills: [createDefaultGuidedSkill(1)],
    guardrails: [],
    outputSections: "Summary\nKey findings\nRecommended next steps",
    outputTemplate: "",
    documentLike: true,
    downloadFileName: "agent-kit-output",
    summaryStyle: "Clear, practical, and user-facing",
    preparedPrompts: [createDefaultGuidedPrompt(1)],
    examples: [createDefaultExample(1)],
    force: false,
  };
}

function guidedBuilderStateFromDraft(draftInput: unknown, outputFolder: string): GuidedBuilderState {
  const draft = isRecord(draftInput) ? draftInput : {};
  const metadata = isRecord(draft.metadata) ? draft.metadata : {};
  const skills = arrayOfRecords(draft.skills);
  const policies = arrayOfRecords(draft.policies);
  const prompts = arrayOfRecords(draft.preparedPrompts);
  const examples = arrayOfRecords(draft.examples);

  return {
    name: stringValue(draft.name, "Imported Agent Kit"),
    id: slugify(stringValue(draft.id, stringValue(draft.name, "imported-agent-kit"))),
    description: stringValue(draft.description, ""),
    domain: stringValue(draft.domain, stringValue(metadata.domain, "")),
    targetUsers: formatUnknownList(draft.targetUsers) || formatUnknownList(metadata.targetUsers),
    validationLevel: "local-valid",
    outputFolder,
    skills: skills.length > 0 ? skills.map((skill, index) => ({
      id: slugify(stringValue(skill.id, `skill-${index + 1}`)),
      name: stringValue(skill.name, stringValue(skill.id, `Skill ${index + 1}`)),
      description: stringValue(skill.description, ""),
      triggers: formatUnknownList(skill.triggers),
      useWhen: stringValue(skill.useWhen, stringValue(skill.use_when, "")),
      doNotUseWhen: stringValue(skill.doNotUseWhen, stringValue(skill.do_not_use_when, "")),
      inputs: formatUnknownList(skill.inputs),
      procedure: formatUnknownList(skill.procedure) || stringValue(skill.procedure, ""),
      output: stringValue(skill.output, stringValue(skill.outputExpectations, "")),
      riskLevel: stringValue(skill.riskLevel, "low") as GuidedSkill["riskLevel"],
    })) : [createDefaultGuidedSkill(1)],
    guardrails: policies.map((policy, index) => ({
      id: stringValue(policy.id, `policy-${index + 1}`),
      text: stringValue(policy.description, stringValue(policy.text, stringValue(policy.name, ""))),
    })),
    outputSections: "Summary\nKey findings\nRecommended next steps",
    outputTemplate: "",
    documentLike: prompts.some((prompt) => prompt.documentLikeOutput === true),
    downloadFileName: "agent-kit-output",
    summaryStyle: "Clear, practical, and user-facing",
    preparedPrompts: prompts.length > 0 ? prompts.map((prompt, index) => ({
      id: slugify(stringValue(prompt.id, `prompt-${index + 1}`)),
      name: stringValue(prompt.name, stringValue(prompt.id, `Prompt ${index + 1}`)),
      description: stringValue(prompt.description, ""),
      template: stringValue(prompt.template, stringValue(prompt.prompt, "")),
      inputs: arrayOfRecords(prompt.inputs).map((input, inputIndex) => ({
        id: promptInputId(stringValue(input.id, `input-${inputIndex + 1}`)),
        label: stringValue(input.label, stringValue(input.id, `Input ${inputIndex + 1}`)),
        description: stringValue(input.description, stringValue(input.helpText, "")),
        required: input.required !== false,
        inputType: normalizeGuidedInputType(stringValue(input.type, "short-text")),
        placeholder: stringValue(input.placeholder, stringValue(input.example, "")),
        defaultValue: stringValue(input.defaultValue, ""),
        includeInPrompt: input.includeInPrompt !== false,
        choices: formatUnknownList(input.choices),
      })),
      outputMode: stringValue(prompt.outputMode, "markdown") as GuidedPreparedPrompt["outputMode"],
      documentLikeOutput: prompt.documentLikeOutput === true,
      suggestedFileName: stringValue(prompt.suggestedFileName, ""),
      tags: formatUnknownList(prompt.tags),
    })) : [createDefaultGuidedPrompt(1)],
    examples: examples.length > 0 ? examples.map((example, index) => ({
      id: stringValue(example.id, `example-${index + 1}`),
      promptId: stringValue(example.promptId, ""),
      prompt: stringValue(example.prompt, ""),
      inputExamples: formatUnknownList(example.inputs) || stringValue(example.inputExamples, ""),
      output: stringValue(example.output, stringValue(example.expectedOutput, "")),
    })) : [createDefaultExample(1)],
    force: true,
  };
}

function normalizeGuidedInputType(value: string): GuidedRequiredInput["inputType"] {
  const allowed: GuidedRequiredInput["inputType"][] = ["short-text", "long-text", "choice", "multi-choice", "date", "number", "boolean"];
  return allowed.includes(value as GuidedRequiredInput["inputType"]) ? value as GuidedRequiredInput["inputType"] : "short-text";
}

function createDefaultGuidedSkill(index: number): GuidedSkill {
  return {
    id: `skill-${index}`,
    name: "",
    description: "",
    triggers: "",
    useWhen: "",
    doNotUseWhen: "",
    inputs: "",
    procedure: "",
    output: "",
    riskLevel: "low",
  };
}

function createDefaultRequiredInput(index: number): GuidedRequiredInput {
  return {
    id: `input-${index}`,
    label: "",
    description: "",
    required: true,
    inputType: "short-text",
    placeholder: "",
    defaultValue: "",
    includeInPrompt: true,
    choices: "",
  };
}

function createDefaultGuidedPrompt(index: number): GuidedPreparedPrompt {
  return {
    id: `prompt-${index}`,
    name: "",
    description: "",
    template: "Help with {{task}} for {{audience}}.",
    inputs: [
      {
        ...createDefaultRequiredInput(1),
        id: "task",
        label: "Task",
        description: "What should the kit help with?",
        placeholder: "Review this workbook and summarize risks.",
      },
      {
        ...createDefaultRequiredInput(2),
        id: "audience",
        label: "Audience",
        description: "Who will read the output?",
        required: false,
        placeholder: "Client team, manager, analyst...",
      },
    ],
    outputMode: "markdown",
    documentLikeOutput: true,
    suggestedFileName: "agent-kit-output.md",
    tags: "",
  };
}

function createDefaultExample(index: number): GuidedExample {
  return {
    id: `example-${index}`,
    promptId: "",
    prompt: "",
    inputExamples: "",
    output: "",
  };
}

function validateGuidedBuilder(form: GuidedBuilderState) {
  if (!form.name.trim()) {
    return "Kit name is required.";
  }
  if (!form.id.trim()) {
    return "Kit ID is required.";
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(form.id.trim())) {
    return "Kit ID must use lowercase letters, numbers, and hyphens.";
  }
  if (!form.description.trim()) {
    return "Description is required.";
  }
  if (!form.outputFolder.trim()) {
    return "Save location is required.";
  }
  const validSkills = form.skills.filter((skill) => skill.name.trim() && skill.description.trim());
  if (validSkills.length === 0) {
    return "Add at least one skill with a name and description.";
  }
  for (const skill of validSkills) {
    if (!skill.triggers.trim() || !skill.useWhen.trim() || !skill.procedure.trim() || !skill.output.trim()) {
      return `Complete triggers, use when, procedure, and output expectations for ${skill.name}.`;
    }
  }
  const validPrompts = form.preparedPrompts.filter((prompt) => prompt.name.trim() && prompt.template.trim());
  for (const prompt of validPrompts) {
    const missingInputs = extractPromptVariables(prompt.template).filter((variable) =>
      !prompt.inputs.some((input) => input.id === variable && input.label.trim()),
    );
    if (missingInputs.length > 0) {
      return `Add inputs for ${prompt.name}: ${missingInputs.join(", ")}.`;
    }
  }
  return null;
}

function buildGuidedAgentKitDraft(form: GuidedBuilderState) {
  const outputConfig = {
    documentLike: form.documentLike,
    suggestedDownloadName: form.downloadFileName,
    summaryStyle: form.summaryStyle,
    outputSections: splitLines(form.outputSections),
  };
  const guardrails = form.guardrails.map((item) => item.text.trim()).filter(Boolean);
  const skills = form.skills
    .filter((skill) => skill.name.trim() && skill.description.trim())
    .map((skill, index) => ({
      id: skill.id || slugify(skill.name) || `skill-${index + 1}`,
      name: skill.name.trim(),
      description: skill.description.trim(),
      triggers: splitLines(skill.triggers).length > 0 ? splitLines(skill.triggers) : [skill.name.trim()],
      riskLevel: skill.riskLevel || "low",
      useWhen: withOptionalSections(skill.useWhen, [
        ["Do not use when", skill.doNotUseWhen],
        ["Inputs", skill.inputs],
      ]),
      procedure: skill.procedure.trim(),
      output: withOptionalSections(skill.output, [
        ["Expected output sections", form.outputSections],
        ["Output template", form.outputTemplate],
      ]),
    }));
  const examples = form.examples
    .filter((example) => example.prompt.trim())
    .map((example, index) => ({
      id: example.id || `example-${index + 1}`,
      prompt: withOptionalSections(example.prompt, [
        ["Prepared prompt", example.promptId],
        ["Example input values", example.inputExamples],
      ]),
      output: example.output.trim() || undefined,
    }));
  const policies = guardrails.length > 0 ? [{ id: "guardrails", description: "Guided Builder guardrails", rules: guardrails }] : [];
  const templates = [
    {
      id: "agentkitforge-output-settings",
      path: "agentkitforge/output-settings.json",
      content: JSON.stringify({ outputConfig }, null, 2),
    },
  ];

  if (form.outputTemplate.trim()) {
    templates.push({
      id: "output-template",
      path: "output-template.md",
      content: form.outputTemplate,
    });
  }

  return {
    schemaVersion: "0.1",
    id: form.id,
    name: form.name,
    version: "0.1.0",
    description: form.description,
    author: { name: "AgentKitForge Guided Builder" },
    license: "MIT",
    setupLevel: "low",
    compatibilityTargets: ["codex", "chatgpt", "claude"],
    riskLevel: highestRiskLevel(skills.map((skill) => skill.riskLevel)),
    agentInstructions: renderGuidedAgentInstructions(form, guardrails),
    startHere: renderGuidedStartHere(form),
    readme: renderGuidedReadme(form),
    changelog: "# Changelog\n\n## 0.1.0\n\nInitial Guided Builder kit.\n",
    skills,
    policies,
    examples,
    templates,
    preparedPrompts: buildGuidedPreparedPrompts(form),
  };
}

function buildGuidedPreparedPrompts(form: GuidedBuilderState) {
  return form.preparedPrompts
    .filter((prompt) => prompt.name.trim() && prompt.template.trim())
    .map((prompt, index) => ({
      id: prompt.id || slugify(prompt.name) || `prompt-${index + 1}`,
      name: prompt.name.trim(),
      description: prompt.description.trim() || prompt.name.trim(),
      template: prompt.template.trim(),
      inputs: prompt.inputs
        .filter((input) => input.label.trim())
        .map((input) => ({
          id: input.id || slugify(input.label),
          label: input.label.trim(),
          description: input.description.trim() || undefined,
          type: input.inputType,
          required: input.required,
          placeholder: input.placeholder.trim() || undefined,
          defaultValue: input.defaultValue.trim() || undefined,
          choices: splitLines(input.choices),
          includeInPrompt: input.includeInPrompt,
        })),
      outputMode: prompt.outputMode,
      documentLikeOutput: prompt.documentLikeOutput,
      suggestedFileName: prompt.suggestedFileName.trim() || undefined,
      tags: splitLines(prompt.tags),
    }));
}

function renderGuidedAgentInstructions(form: GuidedBuilderState, guardrails: string[]) {
  const promptList = form.preparedPrompts
    .filter((prompt) => prompt.name.trim())
    .map((prompt) => `- ${prompt.name}: ${prompt.description || "Reusable prepared prompt."}`)
    .join("\n");
  return `# ${form.name}

${form.description}

## Domain

${form.domain || "General"}

## Target users

${form.targetUsers || "General users"}

## Prepared prompts

${promptList || "- Ask clarifying questions if important details are missing."}

## Guardrails

${guardrails.length > 0 ? guardrails.map((guardrail) => `- ${guardrail}`).join("\n") : "- Flag uncertainty and avoid unsupported claims."}

## Output behavior

- Summary style: ${form.summaryStyle || "Clear and practical"}.
- Document-like output: ${form.documentLike ? "yes" : "no"}.
- Suggested downloadable output name: ${form.downloadFileName || `${form.id}-output`}.
`;
}

function renderGuidedStartHere(form: GuidedBuilderState) {
  const promptList = form.preparedPrompts
    .filter((prompt) => prompt.name.trim())
    .map((prompt) => `- ${prompt.name}`)
    .join("\n");
  return `# ${form.name}

${form.description}

Use this kit for ${form.domain || "general business"} work with ${form.targetUsers || "the intended users"}.

Start by choosing a prepared prompt when one is available, or write a custom prompt:

${promptList || "- Write a custom prompt with the user's task and any relevant context."}
`;
}

function renderGuidedReadme(form: GuidedBuilderState) {
  const promptList = form.preparedPrompts
    .filter((prompt) => prompt.name.trim())
    .map((prompt) => `- **${prompt.name}**: ${prompt.description || "Reusable prepared prompt."}`)
    .join("\n");
  return `# ${form.name}

${form.description}

## Domain

${form.domain || "General"}

## Target users

${form.targetUsers || "General users"}

## Prepared prompts

${promptList || "No prepared prompts were defined."}

## Output style

${form.summaryStyle || "Clear and practical"}
`;
}

function guidedDefaultValidationProfile(form: GuidedBuilderState): ValidationProfile {
  if (form.guardrails.some((guardrail) => guardrail.text.trim()) && form.examples.some((example) => example.prompt.trim())) {
    return "trusted";
  }
  return form.validationLevel === "verified" ? "trusted" : form.validationLevel;
}

function guidedTargetOutputFolder(form: GuidedBuilderState) {
  const root = form.outputFolder.trim();
  const folderName = form.id.trim() || slugify(form.name) || "agent-kit";
  if (!root) {
    return folderName;
  }
  if (root.endsWith("\\") || root.endsWith("/")) {
    return `${root}${folderName}`;
  }
  return `${root}${root.includes("\\") ? "\\" : "/"}${folderName}`;
}

function policyPresetsForDomain(domain: string) {
  const normalized = domain.toLowerCase();
  if (normalized.includes("finance") || normalized.includes("accounting")) {
    return [
      "Do not provide tax filing advice.",
      "Do not claim audit or GAAP compliance.",
      "Require human review before client-facing use.",
    ];
  }
  if (normalized.includes("legal")) {
    return ["Do not provide legal advice.", "Recommend attorney review."];
  }
  if (normalized.includes("health") || normalized.includes("medical")) {
    return ["Do not provide medical advice.", "Recommend clinician review."];
  }
  if (normalized.includes("devops") || normalized.includes("sre")) {
    return [
      "Use read-only diagnostics by default.",
      "Require approval for destructive or mutating actions.",
    ];
  }
  if (normalized.includes("cloud") || normalized.includes("infrastructure")) {
    return [
      "Require approval before making infrastructure changes.",
      "Do not expose secrets.",
    ];
  }
  if (normalized.includes("security")) {
    return [
      "Require authorization.",
      "Do not execute exploits or destructive tests without explicit permission.",
    ];
  }
  if (normalized.includes("compliance")) {
    return [
      "Do not claim certification/compliance status without evidence.",
      "Require human review.",
    ];
  }
  if (normalized.includes("hr") || normalized.includes("recruiting")) {
    return [
      "Avoid discriminatory screening or protected-class inferences.",
      "Require human review.",
    ];
  }
  return ["Flag uncertainty.", "Avoid unsupported claims."];
}

function isRiskyGuidedDomain(domain: string) {
  const normalized = domain.toLowerCase();
  return [
    "finance",
    "accounting",
    "legal",
    "health",
    "medical",
    "devops",
    "sre",
    "cloud",
    "infrastructure",
    "security",
    "compliance",
    "hr",
    "recruiting",
  ].some((keyword) => normalized.includes(keyword));
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

function splitLines(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractPromptVariables(template: string) {
  return Array.from(template.matchAll(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g))
    .map((match) => slugify(match[1]).replace(/-/g, "_"))
    .filter((value, index, values) => value && values.indexOf(value) === index);
}

function renderGuidedPromptPreview(prompt: GuidedPreparedPrompt) {
  return prompt.template.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_match, variable: string) => {
    const normalized = slugify(variable).replace(/-/g, "_");
    const input = prompt.inputs.find((entry) => entry.id === normalized);
    return input?.defaultValue || input?.placeholder || `[${input?.label || normalized}]`;
  });
}

function titleCaseFromId(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function promptInputId(value: string) {
  return slugify(value).replace(/-/g, "_");
}

function withOptionalSections(base: string, sections: Array<[string, string]>) {
  const content = [base.trim()];
  for (const [title, value] of sections) {
    if (value.trim()) {
      content.push(`## ${title}\n\n${value.trim()}`);
    }
  }
  return content.filter(Boolean).join("\n\n");
}

function highestRiskLevel(values: string[]) {
  if (values.includes("high")) {
    return "high";
  }
  if (values.includes("medium")) {
    return "medium";
  }
  return "low";
}

function formatRunResultMarkdown(
  result: RunAgentKitResult,
  runCompletedAt: string | null,
  kitPath: string,
  contextMode: AgentKitContextMode,
  validationProfile: ValidationProfile,
  validateBeforeRun: boolean,
) {
  const timestamp = runCompletedAt ?? new Date().toISOString();
  const warnings =
    result.context.warnings.length > 0
      ? result.context.warnings.map((warning) => `- ${warning}`).join("\n")
      : "- None";
  const skills =
    result.context.includedSkills.length > 0
      ? result.context.includedSkills.map((skill) => `- ${skill}`).join("\n")
      : "- None";
  const files =
    result.context.includedFiles.length > 0
      ? result.context.includedFiles.map((file) => `- ${file}`).join("\n")
      : "- None";

  return `# AgentKitForge Response

## Metadata

- Kit: ${result.kitName || kitPath || "Selected kit"}
- Kit path: ${kitPath || "Unknown"}
- Model: ${result.model}
- Provider: ${result.providerName}
- Context mode: ${contextMode}
- Validation: ${validateBeforeRun ? validationProfile : "Skipped"}
- Timestamp: ${timestamp}
- Approximate context length: ${result.context.approximateContextLength} characters

## Response

${result.response.trim()}

## Included Skills

${skills}

## Included Files

${files}

## Warnings

${warnings}
`;
}

function ModelInput({
  id,
  model,
  onModelChange,
  providerType,
}: {
  id: string;
  model: string;
  onModelChange: (value: string) => void;
  providerType?: AiProviderType;
}) {
  const models = providerType ? getKnownModelsForProvider(providerType) : [];
  return (
    <div className="model-input">
      {models.length > 0 && (
        <select
          aria-label="Known model suggestions"
          onChange={(event) => {
            if (event.target.value) {
              onModelChange(event.target.value);
            }
          }}
          value={models.some((knownModel) => knownModel.id === model) ? model : ""}
        >
          <option value="">Custom model ID</option>
          {models.map((knownModel) => (
            <option key={knownModel.id} value={knownModel.id}>
              {knownModel.label}
            </option>
          ))}
        </select>
      )}
      <input
        id={id}
        onChange={(event) => onModelChange(event.target.value)}
        placeholder={providerType === "openai-compatible" ? "Enter model ID" : "Model ID"}
        value={model}
      />
    </div>
  );
}

function LabelWithHelp({
  help,
  htmlFor,
  label,
}: {
  help: string;
  htmlFor: string;
  label: string;
}) {
  return (
    <label className="label-with-help" htmlFor={htmlFor}>
      <span>{label}</span>
      <HelpTip text={help} />
    </label>
  );
}

function HelpTip({ focusable = true, text }: { focusable?: boolean; text: string }) {
  return (
    <span className="help-tip" tabIndex={focusable ? 0 : -1}>
      ?
      <span className="help-tip-content">{text}</span>
    </span>
  );
}

function DomainSelector({
  id,
  onChange,
  value,
}: {
  id: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const matches = knownDomains
    .filter((domain) => domain.toLowerCase().includes(value.trim().toLowerCase()))
    .slice(0, 8);
  const suggestions = value.trim() === "" ? knownDomains.slice(0, 8) : matches;

  return (
    <div className="domain-selector">
      <input
        id={id}
        list={`${id}-suggestions`}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Start typing, for example Finance or Customer Support"
        value={value}
      />
      <datalist id={`${id}-suggestions`}>
        {[...suggestions, "Other / Custom"].map((domain) => (
          <option key={domain} value={domain} />
        ))}
      </datalist>
    </div>
  );
}

function getSelectedProvider(settings: PublicSettings, providerId?: string) {
  return (
    settings.aiProviders.find((provider) => provider.id === providerId) ??
    settings.aiProviders.find((provider) => provider.id === settings.defaultAiProviderId) ??
    settings.aiProviders[0]
  );
}

function selectedProviderSupportsStructuredJson(provider: AiProviderConfig | undefined, modelId?: string) {
  if (!provider) {
    return false;
  }

  return providerSupportsStructuredJson(
    provider.providerType,
    modelId || provider.model || provider.defaultModel,
    provider.supportsStructuredJson,
  );
}

function defaultProviderForm(settings: PublicSettings): AiProviderForm {
  return {
    name: "OpenAI",
    providerType: "openai",
    baseUrl: defaultBaseUrl("openai"),
    apiKey: "",
    defaultModel: settings.defaultModel || defaultRuntimeModel,
    supportsStructuredJson: providerSupportsStructuredJson("openai", settings.defaultModel || defaultRuntimeModel),
  };
}

function defaultProviderName(providerType: AiProviderType) {
  switch (providerType) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "gemini":
      return "Google Gemini";
    case "ollama":
      return "Ollama";
    case "openai-compatible":
      return "Custom OpenAI-compatible";
  }
}

function defaultBaseUrl(providerType: AiProviderType) {
  return normalizeBaseUrl(providerType) ?? "";
}

function defaultModelForProvider(providerType: AiProviderType) {
  return getDefaultModelForProvider(providerType) ?? "";
}

function AccountScreen({
  onSettingsChange,
  settings,
}: {
  onSettingsChange: (settings: PublicSettings) => void;
  settings: PublicSettings;
}) {
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [deviceLogin, setDeviceLogin] = useState<DeviceLoginStart | null>(null);
  const [authConfig, setAuthConfig] = useState<AccountAuthConfigDiagnostics | null>(null);
  const accountConnection = settings.accountConnection || disconnectedAccountConnection();
  const statusLabel = accountStatusLabel(accountConnection);
  const displayName = accountDisplayName(accountConnection);
  const privateEmail = accountConnection.userEmail || "";
  const isConnecting = accountConnection.accountConnectionStatus === "connecting";
  const needsReconnect = accountConnection.accountConnectionStatus === "error";
  const hostedMarket = defaultExternalServiceConnections.find((connection) => connection.id === "agentkitproject-market");
  const hostedSubmitConnection = hostedMarket
    ? { ...hostedMarket, status: accountConnection.accountConnectionStatus === "connected" ? "connected" as const : "disconnected" as const }
    : undefined;
  const privateMarket = defaultExternalServiceConnections.find((connection) => connection.id === "private-market-placeholder");
  const hostedAuto = defaultExternalServiceConnections.find((connection) => connection.id === "agentkitproject-auto");
  const privateAuto = defaultExternalServiceConnections.find((connection) => connection.id === "private-auto-placeholder");

  useEffect(() => {
    forge.checkAgentKitProjectAuthConfig()
      .then(setAuthConfig)
      .catch(() => setAuthConfig(null));
  }, []);

  async function disconnectAccount() {
    setAccountError(null);
    setAccountMessage(null);
    setDeviceLogin(null);

    try {
      const updatedSettings = await forge.disconnectAgentKitProjectAccount();
      onSettingsChange(updatedSettings);
      setAccountMessage("AgentKitProject account disconnected locally.");
    } catch (caughtError) {
      setAccountError(errorToMessage(caughtError));
    }
  }

  async function connectAccount() {
    setAccountError(null);
    setDeviceLogin(null);
    setAccountMessage("Starting AgentKitProject device login...");
    onSettingsChange({
      ...settings,
      accountConnection: {
        ...accountConnection,
        accountConnectionStatus: "connecting",
        connectionError: undefined,
      },
    });

    try {
      const login = await forge.beginAgentKitProjectAccountLogin();
      setDeviceLogin(login);
      setAccountMessage("Confirm the code in your browser to connect AgentKitForge.");
      const updatedSettings = await forge.completeAgentKitProjectAccountLogin(login.loginId);
      onSettingsChange(updatedSettings);
      setDeviceLogin(null);
      setAccountMessage("AgentKitProject account connected.");
    } catch (caughtError) {
      const safeMessage = errorToMessage(caughtError);
      setAccountError(safeMessage);
      setAccountMessage(null);
      onSettingsChange({
        ...settings,
        accountConnection: {
          ...accountConnection,
          accountConnectionStatus: "error",
          connectionError: safeMessage,
        },
      });
    }
  }

  return (
    <div className="account-screen">
      <section className="form-panel account-panel" data-testid="account-view">
        <h2>AgentKitProject Account</h2>
        <p className="form-copy">
          AgentKitForge works locally without an account. Connect only to use optional hosted AgentKitProject services.
        </p>
        <dl className="report-meta">
          <div>
            <dt>Status</dt>
            <dd>{statusLabel}</dd>
          </div>
          {deviceLogin && (
            <>
              <div>
                <dt>Verification code</dt>
                <dd>{deviceLogin.userCode}</dd>
              </div>
              <div>
                <dt>Verification URL</dt>
                <dd>{deviceLogin.verificationUri}</dd>
              </div>
            </>
          )}
          {displayName && (
            <div>
              <dt>Display</dt>
              <dd>{displayName}</dd>
            </div>
          )}
          {privateEmail && (
            <div>
              <dt>Private account email</dt>
              <dd>{privateEmail}</dd>
            </div>
          )}
          {accountConnection.lastConnectedAt && (
            <div>
              <dt>Last connected</dt>
              <dd>{formatUpdateTimestamp(accountConnection.lastConnectedAt)}</dd>
            </div>
          )}
        </dl>
        {authConfig && !authConfig.configured && (
          <div className="inline-warning">
            AgentKitProject login is missing public config key: {authConfig.missingPublicConfigKeys.join(", ")}.
          </div>
        )}
        <div className="button-row">
          <button
            className="primary-button"
            disabled={isConnecting}
            onClick={accountConnection.accountConnectionStatus === "connected" ? () => openDocsLink(agentKitProjectUrls.profileAccount) : connectAccount}
            type="button"
          >
            {isConnecting ? "Connecting..." : accountConnection.accountConnectionStatus === "connected" ? "Open profile" : needsReconnect ? "Reconnect account" : "Connect account"}
          </button>
          {accountConnection.accountConnectionStatus === "connected" && (
            <button className="secondary-button" onClick={disconnectAccount} type="button">
              Disconnect
            </button>
          )}
          <button className="secondary-button" onClick={() => openDocsLink(agentKitProjectUrls.profileAccount)} type="button">
            Manage profile
          </button>
        </div>
        {accountMessage && <div className="copy-state">{accountMessage}</div>}
        {accountConnection.accountConnectionStatus === "error" && accountConnection.connectionError && (
          <div className="inline-warning">{accountConnection.connectionError}</div>
        )}
        {accountError && (
          <div className="error-state" role="alert">
            {accountError}
          </div>
        )}
      </section>

      <section className="form-panel account-panel" data-testid="markets-integrations-section">
        <h2>Markets</h2>
        <div className="provider-card-header">
          <p>Browse hosted or private Market sources. Download kits and import them into Forge.</p>
          <span className="provider-badge">Optional</span>
        </div>
        <p className="form-copy">
          AgentKitForge works locally. Market is optional. Manual .agentkit.zip import remains available without account login or service connection.
        </p>
        <div className="provider-card compact-service-card" data-testid="hosted-market-card">
          <div className="provider-card-header">
            <div>
              <h3>{hostedMarket?.name || "AgentKitMarket"}</h3>
              <p>Hosted AgentKitMarket uses your optional AgentKitProject account for hosted service features.</p>
            </div>
            <span className="provider-badge">{hostedMarket?.status === "connected" ? "Connected" : "Browse available"}</span>
          </div>
          <dl className="report-meta">
            <div>
              <dt>Base URL</dt>
              <dd>{hostedMarket?.baseUrl || agentKitProjectUrls.market}</dd>
            </div>
            <div>
              <dt>Auth mode</dt>
              <dd>AgentKitProject</dd>
            </div>
            <div>
              <dt>Direct import</dt>
              <dd>{accountConnection.accountConnectionStatus === "connected" ? "Available" : "Requires AgentKitProject account"}</dd>
            </div>
            <div>
              <dt>Submit</dt>
              <dd>{hostedSubmitConnection && canUseMarketSubmit(hostedSubmitConnection) ? "Available for hosted Market" : "Requires AgentKitProject account"}</dd>
            </div>
          </dl>
        </div>
        <div className="provider-card compact-service-card" data-testid="private-market-card">
          <div className="provider-card-header">
            <div>
              <h3>{privateMarket?.name || "Private Market"}</h3>
              <p>Private markets use their own credentials and identity provider. An AgentKitProject account is not required unless that market chooses it.</p>
            </div>
            <span className="provider-badge">Coming soon</span>
          </div>
          <label className="field-label" htmlFor="private-market-base-url-account">Private Market base URL</label>
          <input
            disabled
            id="private-market-base-url-account"
            placeholder="https://market.company.example"
            type="url"
            value={privateMarket?.baseUrl || ""}
          />
        </div>
        <div className="button-row">
          <button className="secondary-button" onClick={() => openDocsLink(agentKitProjectUrls.marketKits)} type="button">
            Open AgentKitMarket
          </button>
          <button className="secondary-button" onClick={() => setAccountMessage("Add private Market connection is coming soon.")} type="button">
            Add private Market
          </button>
          <button className="secondary-button" onClick={() => openDocsLink(agentKitProjectUrls.market)} type="button">
            Market home
          </button>
          <button className="secondary-button" disabled type="button">
            Private Market import coming soon
          </button>
        </div>
      </section>

      <section className="form-panel account-panel" data-testid="auto-integrations-section">
        <h2>Auto</h2>
        <div className="provider-card-header">
          <p>Auto connections are optional. Private Auto instances will use their own credentials and identity provider.</p>
          <span className="provider-badge">Coming soon</span>
        </div>
        <div className="provider-card compact-service-card" data-testid="hosted-auto-card">
          <div className="provider-card-header">
            <div>
              <h3>{hostedAuto?.name || "AgentKitAuto"}</h3>
              <p>Hosted AgentKitAuto will use your optional AgentKitProject account when it becomes available.</p>
            </div>
            <span className="provider-badge">Coming soon</span>
          </div>
          <dl className="report-meta">
            <div>
              <dt>Base URL</dt>
              <dd>{hostedAuto?.baseUrl || "Not live yet"}</dd>
            </div>
            <div>
              <dt>Run automation</dt>
              <dd>{hostedAuto && canUseAuto(hostedAuto) ? "Available" : "Coming soon"}</dd>
            </div>
          </dl>
        </div>
        <div className="provider-card compact-service-card" data-testid="private-auto-card">
          <div className="provider-card-header">
            <div>
              <h3>{privateAuto?.name || "Private Auto"}</h3>
              <p>Company/private Auto instances should use their own self-managed auth, not AgentKitProject credentials.</p>
            </div>
            <span className="provider-badge">Coming soon</span>
          </div>
          <label className="field-label" htmlFor="private-auto-base-url-account">Private Auto base URL</label>
          <input
            disabled
            id="private-auto-base-url-account"
            placeholder="https://auto.company.example"
            type="url"
            value={privateAuto?.baseUrl || ""}
          />
        </div>
        <div className="button-row">
          <button className="secondary-button" disabled type="button">
            Add Auto connection later
          </button>
        </div>
      </section>

      <section className="form-panel account-panel">
        <h2>Local-first Status</h2>
        <p className="form-copy">
          Create Agent Kits, edit kits, Build with AI, validate, package, export, import local packages, and manage My Kits without signing in.
        </p>
        <dl className="report-meta">
          <div>
            <dt>Local Forge features</dt>
            <dd>{canUseLocalForgeFeatures() ? "Available without account" : "Unavailable"}</dd>
          </div>
          <div>
            <dt>Market submit</dt>
            <dd>{hostedSubmitConnection && canUseMarketSubmit(hostedSubmitConnection) ? "Available for hosted Market" : "Requires AgentKitProject account for hosted Market"}</dd>
          </div>
          <div>
            <dt>Manual local import</dt>
            <dd>{canUseManualPackageImport() ? "Available without account" : "Unavailable"}</dd>
          </div>
          <div>
            <dt>Direct Market import</dt>
            <dd>{accountConnection.accountConnectionStatus === "connected" ? "Available for hosted Market" : "Requires AgentKitProject account for hosted Market"}</dd>
          </div>
          <div>
            <dt>Manual Market import</dt>
            <dd>{canUseManualMarketImport() ? "Available without account" : "Unavailable"}</dd>
          </div>
          <div>
            <dt>Auto</dt>
            <dd>{hostedAuto && canUseAuto(hostedAuto) ? "Available" : "Requires explicit Auto connection later"}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function SettingsScreen({
  appState,
  appVersion,
  onCheckForUpdates,
  onInstallUpdate,
  onOpenAccount,
  onSettingsChange,
  onUpdate,
  settings,
  updateState,
}: {
  appState: AppState;
  appVersion: string;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
  onOpenAccount: () => void;
  onSettingsChange: (settings: PublicSettings) => void;
  onUpdate: <Key extends keyof AppState>(key: Key, value: AppState[Key]) => void;
  settings: PublicSettings;
  updateState: AppUpdateState;
}) {
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [isClearingKey, setIsClearingKey] = useState(false);
  const [defaultModel, setDefaultModel] = useState(settings.defaultModel);
  const [defaultOutputFolder, setDefaultOutputFolder] = useState(settings.defaultOutputFolder);
  const [preferredValidationProfile, setPreferredValidationProfile] = useState<ValidationProfile>(
    settings.preferredValidationProfile,
  );
  const [preferredContextMode, setPreferredContextMode] = useState<AgentKitContextMode>(
    settings.preferredContextMode,
  );
  const [theme, setTheme] = useState<ThemeMode>(settings.theme);
  const [includePolicies, setIncludePolicies] = useState(settings.includePolicies);
  const [includeTemplates, setIncludeTemplates] = useState(settings.includeTemplates);
  const [includeWorkflows, setIncludeWorkflows] = useState(settings.includeWorkflows);
  const [includeReferences, setIncludeReferences] = useState(settings.includeReferences);
  const [defaultValidateBeforeRun, setDefaultValidateBeforeRun] = useState(
    () => window.localStorage.getItem("agentkitforge.defaultValidateBeforeRun") !== "false",
  );
  const [defaultOutputFormat, setDefaultOutputFormat] = useState(
    () => window.localStorage.getItem("agentkitforge.defaultOutputFormat") || "markdown",
  );
  const [isSavingPreferences, setIsSavingPreferences] = useState(false);
  const [isSelectingOutputFolder, setIsSelectingOutputFolder] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [providerForm, setProviderForm] = useState<AiProviderForm>(() => defaultProviderForm(settings));

  useEffect(() => {
    setDefaultModel(settings.defaultModel);
    setDefaultOutputFolder(settings.defaultOutputFolder);
    setPreferredValidationProfile(settings.preferredValidationProfile);
    setPreferredContextMode(settings.preferredContextMode);
    setTheme(settings.theme);
    setIncludePolicies(settings.includePolicies);
    setIncludeTemplates(settings.includeTemplates);
    setIncludeWorkflows(settings.includeWorkflows);
    setIncludeReferences(settings.includeReferences);
  }, [settings]);

  function editProvider(provider: AiProviderConfig) {
    setProviderForm({
      id: provider.id,
      name: provider.name,
      providerType: provider.providerType,
      baseUrl: provider.baseUrl || defaultBaseUrl(provider.providerType),
      apiKey: "",
      defaultModel: provider.defaultModel,
      supportsStructuredJson: provider.supportsStructuredJson,
    });
    setSettingsError(null);
    setSettingsMessage(null);
  }

  function updateProviderType(providerType: AiProviderType) {
    const nextModel = defaultModelForProvider(providerType);
    setProviderForm((current) => ({
      ...current,
      providerType,
      name: current.id ? current.name : defaultProviderName(providerType),
      baseUrl: current.id ? current.baseUrl : defaultBaseUrl(providerType),
      defaultModel: current.id ? current.defaultModel : nextModel,
      supportsStructuredJson: providerSupportsStructuredJson(
        providerType,
        current.id ? current.defaultModel : nextModel,
      ),
    }));
  }

  async function saveProvider() {
    setSettingsError(null);
    setSettingsMessage(null);
    setIsSavingKey(true);
    try {
      const normalizedProviderForm = {
        ...providerForm,
        baseUrl: normalizeBaseUrl(providerForm.providerType, providerForm.baseUrl) ?? "",
      };
      const updatedSettings = await forge.saveAiProvider(normalizedProviderForm);
      onSettingsChange(updatedSettings);
      setProviderForm(defaultProviderForm(updatedSettings));
      setSettingsMessage("AI provider saved locally.");
    } catch (caughtError) {
      setSettingsError(errorToMessage(caughtError));
    } finally {
      setIsSavingKey(false);
    }
  }

  async function removeProvider(providerId: string) {
    setSettingsError(null);
    setSettingsMessage(null);
    try {
      const updatedSettings = await forge.removeAiProvider(providerId);
      onSettingsChange(updatedSettings);
      setSettingsMessage("AI provider removed.");
    } catch (caughtError) {
      setSettingsError(errorToMessage(caughtError));
    }
  }

  async function setDefaultProvider(providerId: string) {
    setSettingsError(null);
    setSettingsMessage(null);
    try {
      const updatedSettings = await forge.setDefaultAiProvider(providerId);
      onSettingsChange(updatedSettings);
      setSettingsMessage("Default AI provider updated.");
    } catch (caughtError) {
      setSettingsError(errorToMessage(caughtError));
    }
  }

  async function saveApiKey() {
    setIsSavingKey(true);
    setSettingsError(null);
    setSettingsMessage(null);

    try {
      const updatedSettings = await forge.saveOpenAiApiKey(appState.openAiApiKey);
      onSettingsChange(updatedSettings);
      onUpdate("openAiApiKey", "");
      setSettingsMessage("OpenAI API key saved locally.");
    } catch (caughtError) {
      setSettingsError(errorToMessage(caughtError));
    } finally {
      setIsSavingKey(false);
    }
  }

  async function clearApiKey() {
    setIsClearingKey(true);
    setSettingsError(null);
    setSettingsMessage(null);

    try {
      const updatedSettings = await forge.clearOpenAiApiKey();
      onSettingsChange(updatedSettings);
      onUpdate("openAiApiKey", "");
      setSettingsMessage("OpenAI API key cleared.");
    } catch (caughtError) {
      setSettingsError(errorToMessage(caughtError));
    } finally {
      setIsClearingKey(false);
    }
  }

  async function savePreferences() {
    setIsSavingPreferences(true);
    setSettingsError(null);
    setSettingsMessage(null);

    try {
      const updatedSettings = await forge.saveAppPreferences({
          defaultModel,
          defaultOutputFolder,
          preferredValidationProfile,
          preferredContextMode,
          theme,
          includePolicies,
          includeTemplates,
          includeWorkflows,
          includeReferences,
        });
      onSettingsChange(updatedSettings);
      onUpdate("defaultOutputFolder", updatedSettings.defaultOutputFolder);
      onUpdate("preferredValidationProfile", updatedSettings.preferredValidationProfile);
      setSettingsMessage("Preferences saved.");
      window.localStorage.setItem("agentkitforge.defaultValidateBeforeRun", String(defaultValidateBeforeRun));
      window.localStorage.setItem("agentkitforge.defaultOutputFormat", defaultOutputFormat);
    } catch (caughtError) {
      setSettingsError(errorToMessage(caughtError));
    } finally {
      setIsSavingPreferences(false);
    }
  }

  async function selectDefaultOutputFolder() {
    setIsSelectingOutputFolder(true);
    setSettingsError(null);

    try {
      const selectedPath = await forge.selectAgentKitFolder();
      if (selectedPath) {
        setDefaultOutputFolder(selectedPath);
      }
    } catch (caughtError) {
      setSettingsError(errorToMessage(caughtError));
    } finally {
      setIsSelectingOutputFolder(false);
    }
  }

  async function testOpenAIConnection() {
    setIsTestingConnection(true);
    setSettingsError(null);
    setSettingsMessage(null);

    try {
      const result = await forge.testAiProviderConnection({ providerId: providerForm.id || settings.defaultAiProviderId, model: providerForm.defaultModel || defaultModel });
      setSettingsMessage(`${result.message} Model: ${result.model}.`);
    } catch (caughtError) {
      setSettingsError(errorToMessage(caughtError));
    } finally {
      setIsTestingConnection(false);
    }
  }

  const exportsFolder = appExportsFolder({ ...settings, defaultOutputFolder });
  const draftsFolder = siblingAppFolder(defaultOutputFolder, "Drafts");
  const rememberedCodexFolder = window.localStorage.getItem("agentkitforge.codexSkillsDestination") || "";
  const rememberedClaudeFolder = window.localStorage.getItem("agentkitforge.claudeCodeDestination") || "";

  return (
    <div className="settings-screen">
      <section className="form-panel settings-panel">
      <h2>AI Providers</h2>
      {settings.aiProviders.length === 0 && (
        <div className="inline-warning">
          Add OpenAI, Anthropic, Gemini, Ollama, or a custom OpenAI-compatible provider.
        </div>
      )}

      <div className="provider-list">
        {settings.aiProviders.map((provider) => (
          <article className="provider-card" key={provider.id}>
            <div>
              <strong>{provider.name}</strong>
              <p>{provider.providerType} · {provider.defaultModel}</p>
            </div>
            <span className={`secret-status ${provider.hasApiKey || provider.providerType === "ollama" ? "saved" : ""}`}>
              {provider.hasApiKey ? "Key saved" : provider.providerType === "ollama" ? "No key required" : "No key"}
            </span>
            <div className="button-row">
              <button className="secondary-button compact-button" onClick={() => editProvider(provider)} type="button">
                Edit
              </button>
              <button className="secondary-button compact-button" onClick={() => setDefaultProvider(provider.id)} type="button">
                {settings.defaultAiProviderId === provider.id ? "Default" : "Make default"}
              </button>
              <button className="secondary-button compact-button" onClick={() => removeProvider(provider.id)} type="button">
                Remove
              </button>
            </div>
          </article>
        ))}
      </div>

      <h2>{providerForm.id ? "Edit provider" : "Add provider"}</h2>
      <div className="settings-grid two-column">
        <div>
          <label htmlFor="provider-type">Provider type</label>
          <select
            id="provider-type"
            onChange={(event) => updateProviderType(event.target.value as AiProviderType)}
            value={providerForm.providerType}
          >
            {aiProviderTypes.map((providerType) => (
              <option key={providerType} value={providerType}>
                {providerType}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="provider-name">Provider name</label>
          <input
            id="provider-name"
            onChange={(event) => setProviderForm((current) => ({ ...current, name: event.target.value }))}
            value={providerForm.name}
          />
        </div>
      </div>

      <details className="advanced-details">
        <summary>Advanced provider settings</summary>
        <LabelWithHelp
          htmlFor="provider-base-url"
          label="Base URL"
          help="Only change this for local servers, gateways, or custom OpenAI-compatible providers."
        />
        <input
          id="provider-base-url"
          onChange={(event) => setProviderForm((current) => ({ ...current, baseUrl: event.target.value }))}
          placeholder={isBaseUrlRequiredForProvider(providerForm.providerType) ? "Required" : defaultBaseUrl(providerForm.providerType) || "Optional"}
          value={providerForm.baseUrl}
        />
        <div className="inline-warning">
          Non-local HTTP providers may send prompts and keys without encryption. Use HTTPS for remote providers; HTTP is allowed only for local addresses such as localhost, 127.0.0.1, or ::1.
        </div>

        <label className="checkbox-row" htmlFor="provider-structured-json">
          <input
            checked={providerForm.supportsStructuredJson}
            id="provider-structured-json"
            onChange={(event) => setProviderForm((current) => ({ ...current, supportsStructuredJson: event.target.checked }))}
            type="checkbox"
          />
          <span>Provider can reliably return structured JSON</span>
          <HelpTip text="This matters for Build with AI because drafts must be valid JSON before rendering." />
        </label>
        {getProviderCapabilities(providerForm.providerType).notes && (
          <p className="form-copy">{getProviderCapabilities(providerForm.providerType).notes}</p>
        )}
      </details>

      <label htmlFor="provider-api-key">API key</label>
      <div className="input-with-icon">
        <KeyRound size={18} />
        <input
          id="provider-api-key"
          onChange={(event) => setProviderForm((current) => ({ ...current, apiKey: event.target.value }))}
          placeholder={
            providerForm.id
              ? "Saved key is hidden. Enter a new key to update."
              : isApiKeyRequiredForProvider(providerForm.providerType)
                ? "Required"
                : "Optional for local providers"
          }
          type="password"
          value={providerForm.apiKey}
        />
      </div>

      <label htmlFor="provider-model">Default model</label>
      <ModelInput
        id="provider-model"
        model={providerForm.defaultModel}
        onModelChange={(value) => setProviderForm((current) => ({ ...current, defaultModel: value }))}
        providerType={providerForm.providerType}
      />

      <div className="button-row">
        <button className="primary-button" disabled={isSavingKey} onClick={saveProvider} type="button">
          {isSavingKey && <InlineSpinner className="button-spinner" />}
          {isSavingKey ? "Saving" : "Save provider"}
        </button>
        <button className="secondary-button" onClick={() => setProviderForm(defaultProviderForm(settings))} type="button">
          New provider
        </button>
        <button
          className="secondary-button"
          disabled={isTestingConnection || settings.aiProviders.length === 0}
          onClick={testOpenAIConnection}
          type="button"
        >
          {isTestingConnection && <InlineSpinner className="button-spinner" />}
          {isTestingConnection ? "Testing" : "Test selected provider"}
        </button>
      </div>
      {isTestingConnection && <LoadingStatus text="Testing provider connection..." />}

      <div className="inline-warning">
        Provider API keys are stored locally in this app&apos;s settings file on your machine. Do not use shared or untrusted machines. You can clear stored keys from Settings.
      </div>

      {settingsMessage && <div className="copy-state">{settingsMessage}</div>}
      {settingsError && (
        <div className="error-state" role="alert">
          {settingsError}
        </div>
      )}
      </section>

      <section className="form-panel settings-panel">
      <h2>Storage & Folders</h2>
      <p className="form-copy">
        AgentKitForge uses friendly folder labels in the app. Full paths are shown here for setup.
      </p>
      <LabelWithHelp htmlFor="default-output-folder" label="AgentKitForge Library" help="New kits and imports use this folder by default." />
      <div className="path-picker">
        <input
          id="default-output-folder"
          onChange={(event) => setDefaultOutputFolder(event.target.value)}
          placeholder="Documents/AgentKitForge/Kits"
          value={defaultOutputFolder}
        />
        <button
          className="icon-button"
          disabled={isSelectingOutputFolder}
          onClick={selectDefaultOutputFolder}
          title="Select output folder"
          type="button"
        >
          <FolderOpen size={18} />
        </button>
      </div>
      <dl className="report-meta">
        <div>
          <dt>Exports folder</dt>
          <dd>{exportsFolder || "Set the AgentKitForge Library first"}</dd>
        </div>
        <div>
          <dt>Drafts folder</dt>
          <dd>{draftsFolder || "Set the AgentKitForge Library first"}</dd>
        </div>
        <div>
          <dt>Remembered Codex folder</dt>
          <dd>{rememberedCodexFolder || "Choose this from Install on Local Agent"}</dd>
        </div>
        <div>
          <dt>Remembered Claude Code folder</dt>
          <dd>{rememberedClaudeFolder || "Choose this from Install on Local Agent"}</dd>
        </div>
      </dl>
      </section>

      <section className="form-panel settings-panel">
      <h2>Default Behavior</h2>
      <LabelWithHelp htmlFor="preferred-validation-profile" label="Preferred validation level" help="Used as the starting validation level across workflows." />
      <select
        id="preferred-validation-profile"
        onChange={(event) => setPreferredValidationProfile(event.target.value as ValidationProfile)}
        value={preferredValidationProfile}
      >
        {validationProfiles.map((validationProfile) => (
          <option key={validationProfile} value={validationProfile}>
            {validationProfile}
          </option>
        ))}
      </select>

      <LabelWithHelp htmlFor="preferred-context-mode" label="Default context mode" help="Used as the starting context mode in Use inside Forge." />
      <select
        id="preferred-context-mode"
        onChange={(event) => setPreferredContextMode(event.target.value as AgentKitContextMode)}
        value={preferredContextMode}
      >
        {contextModes.map((mode) => (
          <option key={mode} value={mode}>
            {mode}
          </option>
        ))}
      </select>

      <label className="checkbox-row" htmlFor="settings-validate-before-run">
        <input
          checked={defaultValidateBeforeRun}
          id="settings-validate-before-run"
          onChange={(event) => setDefaultValidateBeforeRun(event.target.checked)}
          type="checkbox"
        />
        <span>Validate before running by default</span>
      </label>

      <LabelWithHelp htmlFor="settings-default-output-format" label="Default output format" help="Used for response download defaults where the app can apply it." />
      <select
        id="settings-default-output-format"
        onChange={(event) => setDefaultOutputFormat(event.target.value)}
        value={defaultOutputFormat}
      >
        <option value="markdown">Markdown</option>
        <option value="text">Text</option>
      </select>

      <div className="checkbox-grid">
        <label className="checkbox-row" htmlFor="settings-include-policies">
          <input
            checked={includePolicies}
            id="settings-include-policies"
            onChange={(event) => setIncludePolicies(event.target.checked)}
            type="checkbox"
          />
          <span>Include policies</span>
        </label>
        <label className="checkbox-row" htmlFor="settings-include-templates">
          <input
            checked={includeTemplates}
            id="settings-include-templates"
            onChange={(event) => setIncludeTemplates(event.target.checked)}
            type="checkbox"
          />
          <span>Include templates</span>
        </label>
        <label className="checkbox-row" htmlFor="settings-include-workflows">
          <input
            checked={includeWorkflows}
            id="settings-include-workflows"
            onChange={(event) => setIncludeWorkflows(event.target.checked)}
            type="checkbox"
          />
          <span>Include workflows</span>
        </label>
        <label className="checkbox-row" htmlFor="settings-include-references">
          <input
            checked={includeReferences}
            id="settings-include-references"
            onChange={(event) => setIncludeReferences(event.target.checked)}
            type="checkbox"
          />
          <span>Include references</span>
        </label>
      </div>
      </section>

      <section className="form-panel settings-panel">
      <h2>Appearance</h2>
      <LabelWithHelp htmlFor="app-theme" label="Theme" help="Choose the app theme. System theme can be added later." />
      <select
        id="app-theme"
        onChange={(event) => setTheme(event.target.value as ThemeMode)}
        value={theme}
      >
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>

      <button
        className="primary-button settings-inline-button"
        disabled={isSavingPreferences}
        onClick={savePreferences}
        type="button"
      >
        {isSavingPreferences && <InlineSpinner className="button-spinner" />}
        {isSavingPreferences ? "Saving" : "Save preferences"}
      </button>
      </section>

      <section className="form-panel settings-panel">
      <h2>Account & Integrations</h2>
      <p className="form-copy">
        AgentKitForge works locally without an account. Use the Account view to connect optional AgentKitProject services like Market or Auto.
      </p>
      <div className="button-row">
        <button className="secondary-button" onClick={onOpenAccount} type="button">
          Open Account
        </button>
      </div>
      </section>

      <section className="form-panel settings-panel">
      <h2>Updates</h2>
      <p className="form-copy">
        AgentKitForge checks forge.agentkitproject.com for signed desktop updates. Updates are never installed until you choose Update now.
      </p>
      <dl className="report-meta">
        <div>
          <dt>Current version</dt>
          <dd>{appVersion}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{updateStatusLabel(updateState.status)}</dd>
        </div>
        <div>
          <dt>Last checked</dt>
          <dd>{formatUpdateTimestamp(updateState.lastCheckedAt || settings.lastUpdateCheckAt)}</dd>
        </div>
        {updateState.update && (
          <div>
            <dt>Available version</dt>
            <dd>{updateState.update.version}</dd>
          </div>
        )}
      </dl>
      {updateState.message && <div className="copy-state">{updateState.message}</div>}
      {updateState.error && (
        <div className="error-state" role="alert">
          {updateState.error}
        </div>
      )}
      <div className="button-row">
        <button
          className="secondary-button"
          disabled={updateState.status === "checking" || updateState.status === "downloading" || updateState.status === "installing"}
          onClick={onCheckForUpdates}
          type="button"
        >
          {updateState.status === "checking" && <InlineSpinner className="button-spinner" />}
          {updateState.status === "checking" ? "Checking" : "Check for updates"}
        </button>
        {updateState.update && (
          <button
            className="primary-button"
            disabled={updateState.status === "downloading" || updateState.status === "installing"}
            onClick={onInstallUpdate}
            type="button"
          >
            {(updateState.status === "downloading" || updateState.status === "installing") && (
              <InlineSpinner className="button-spinner" />
            )}
            {updateState.status === "installing" ? "Installing" : updateState.status === "downloading" ? "Downloading" : "Update now"}
          </button>
        )}
      </div>
      </section>

      <section className="form-panel settings-panel">
      <h2>Security & Privacy</h2>
      <p className="form-copy">
        AgentKitForge stores provider settings and My Kits locally on this machine. It does not require an account or sync your local library.
      </p>
      <div className="inline-warning">
        Provider API keys are stored locally in this app&apos;s settings file on your machine. Do not use shared or untrusted machines. Remove a provider above to clear its saved key.
      </div>
      <button className="secondary-button settings-inline-button" disabled={isClearingKey} onClick={clearApiKey} type="button">
        {isClearingKey && <InlineSpinner className="button-spinner" />}
        Clear legacy OpenAI key
      </button>
      </section>

      <section className="form-panel settings-panel">
      <h2>About</h2>
      <p className="form-copy">
        AgentKitForge {appVersion} is a desktop workspace for building, packaging, installing, and using portable Agent Kits.
      </p>
      <div className="about-links">
        <button onClick={() => openDocsLink("https://forge.agentkitproject.com/")} type="button">Forge website</button>
        <button onClick={() => openDocsLink("https://forge.agentkitproject.com/docs/")} type="button">Docs</button>
        <button onClick={() => openDocsLink("https://forge.agentkitproject.com/agent-kit-spec/")} type="button">Agent Kit Spec</button>
      </div>
      </section>
    </div>
  );
}

function AboutScreen({ appVersion, settings }: { appVersion: string; settings: PublicSettings }) {
  return (
    <div className="about-screen">
      <section className="form-panel about-panel">
        <div className="about-header">
          <img alt="" className="about-mark" src={agentKitForgeIcon} />
          <div>
            <h2>AgentKitForge</h2>
            <p>Version {appVersion}</p>
          </div>
        </div>

        <p className="form-copy">
          AgentKitForge is a downloadable desktop app for building, validating, packaging,
          installing, and using portable Agent Kits.
        </p>

        <dl className="report-meta about-meta">
          <div>
            <dt>App mode</dt>
            <dd>Local desktop workspace</dd>
          </div>
          <div>
            <dt>Settings file</dt>
            <dd>{settings.settingsPath || "Resolved by Tauri app-local data at runtime"}</dd>
          </div>
        </dl>

        <div className="about-links">
          <button onClick={() => openDocsLink("https://forge.agentkitproject.com/")} type="button">
            Forge website
          </button>
          <button onClick={() => openDocsLink("https://forge.agentkitproject.com/docs/")} type="button">
            Docs
          </button>
          <button onClick={() => openDocsLink("https://forge.agentkitproject.com/agent-kit-spec/")} type="button">
            Agent Kit Spec
          </button>
        </div>
      </section>

      <section className="form-panel about-panel">
        <h2>Privacy and Storage</h2>
        <p className="form-copy">
          AgentKitForge stores My Kits entries and app preferences locally on this machine. It does
          not require an account and does not sync local library data remotely.
        </p>
        <div className="inline-warning">
          Provider API keys are stored locally in this app&apos;s settings file on your machine. Do not use shared or untrusted machines. You can clear stored keys from Settings.
        </div>
      </section>
    </div>
  );
}

function CreateAgentKitResults({
  error,
  isLoading,
  onValidateCreatedKit,
  result,
  validationProfile,
}: {
  error: string | null;
  isLoading: boolean;
  onValidateCreatedKit: (rootPath: string) => void;
  result: CreateAgentKitResult | null;
  validationProfile: ValidationProfile;
}) {
  if (isLoading) {
    return <LoadingStatus text="Creating Agent Kit from template..." />;
  }

  if (error) {
    return (
      <div className="error-state" role="alert">
        {error}
      </div>
    );
  }

  if (!result) {
    return <p className="state-copy">Create a kit to see the generated files and root path.</p>;
  }

  return (
    <div className="create-result">
      <div className="status-banner valid">
        <strong>Created</strong>
        <span>{result.files.length} file{result.files.length === 1 ? "" : "s"}</span>
      </div>

      <dl className="report-meta">
        <div>
          <dt>Template</dt>
          <dd>{result.template}</dd>
        </div>
        <div>
          <dt>Validation profile</dt>
          <dd>{validationProfile}</dd>
        </div>
      </dl>
      <details className="advanced-details">
        <summary>Advanced details</summary>
        <dl className="report-meta">
          <div>
            <dt>Full folder path</dt>
            <dd>{result.rootPath}</dd>
          </div>
        </dl>
      </details>

      <div className="created-files">
        <h3>Created files</h3>
        <ul>
          {result.files.map((file) => (
            <li key={file}>{file}</li>
          ))}
        </ul>
      </div>

      <button
        className="primary-button"
        onClick={() => onValidateCreatedKit(result.rootPath)}
        type="button"
      >
        <CheckCircle2 size={18} />
        Validate created kit
      </button>
    </div>
  );
}

function RenderAgentKitDraftResults({
  error,
  isLoading,
  onValidateRenderedKit,
  result,
}: {
  error: string | null;
  isLoading: boolean;
  onValidateRenderedKit: (rootPath: string) => void;
  result: RenderAgentKitDraftResult | null;
}) {
  if (isLoading) {
    return <LoadingStatus text="Rendering Agent Kit from draft JSON..." />;
  }

  if (error) {
    return (
      <div className="error-state" role="alert">
        {error}
      </div>
    );
  }

  if (!result) {
    return <p className="state-copy">Render a draft JSON file to see the generated kit files.</p>;
  }

  return (
    <div className="create-result">
      <div className="status-banner valid">
        <strong>Rendered</strong>
        <span>{result.files.length} file{result.files.length === 1 ? "" : "s"}</span>
      </div>

      <dl className="report-meta">
        <div>
          <dt>Validation profile</dt>
          <dd>local-valid</dd>
        </div>
      </dl>
      <details className="advanced-details">
        <summary>Advanced details</summary>
        <dl className="report-meta">
          <div>
            <dt>Full folder path</dt>
            <dd>{result.rootPath}</dd>
          </div>
        </dl>
      </details>

      <div className="created-files">
        <h3>Created files</h3>
        <ul>
          {result.files.map((file) => (
            <li key={file}>{file}</li>
          ))}
        </ul>
      </div>

      <button
        className="primary-button"
        onClick={() => onValidateRenderedKit(result.rootPath)}
        type="button"
      >
        <CheckCircle2 size={18} />
        Validate rendered kit
      </button>
    </div>
  );
}

function GeneratedDraftResults({
  changeRequest,
  copyState,
  error,
  isLoading,
  isRevising,
  isRenderingDraft,
  isSelectingRenderOutput,
  onChangeRequestChange,
  onClearSession,
  onCopyJson,
  onRenderDraft,
  onRenderForceChange,
  onRenderOutputFolderChange,
  onRequestChanges,
  onRestoreRevision,
  onAddToMyKits,
  onPackageKit,
  onSaveJson,
  onSaveUpdate,
  onSelectRenderOutputFolder,
  onUseKit,
  onValidateRenderedKit,
  renderError,
  renderForce,
  renderOutputFolder,
  renderResult,
  result,
  savePath,
  saveLabel = "Save",
  updateLabel,
}: {
  changeRequest: string;
  copyState: "idle" | "copied" | "failed";
  error: string | null;
  isLoading: boolean;
  isRevising: boolean;
  isRenderingDraft: boolean;
  isSelectingRenderOutput: boolean;
  onChangeRequestChange: (value: string) => void;
  onClearSession: () => void;
  onCopyJson: () => void;
  onRenderDraft: () => void;
  onRenderForceChange: (value: boolean) => void;
  onRenderOutputFolderChange: (value: string) => void;
  onRequestChanges: () => void;
  onRestoreRevision: (revisionId: string) => void;
  onAddToMyKits: (rootPath: string) => void;
  onPackageKit: (rootPath: string) => void;
  onSaveJson: () => void;
  onSaveUpdate?: () => void;
  onSelectRenderOutputFolder: () => void;
  onUseKit: (rootPath: string) => void;
  onValidateRenderedKit: (rootPath: string) => void;
  renderError: string | null;
  renderForce: boolean;
  renderOutputFolder: string;
  renderResult: RenderAgentKitDraftResult | null;
  result: GenerateAgentKitDraftResult | null;
  savePath: string | null;
  saveLabel?: string;
  updateLabel?: string;
}) {
  if (isLoading) {
    return <LoadingStatus text="Asking provider and validating draft response..." />;
  }

  if (error) {
    return (
      <div className="error-state" role="alert">
        {error}
      </div>
    );
  }

  if (!result) {
    return (
      <p className="state-copy">
        Generate or load a draft, review it, then click Save to create the Agent Kit files.
      </p>
    );
  }

  const currentRevision = result.currentRevision ?? currentDraftRevision(result.session);
  const currentDraft = currentRevision?.draft ?? result.draftJson;
  const draftSummary = summarizeAgentKitDraft(currentDraft);

  return (
    <div className="generated-draft-result">
      <div className="status-banner valid">
        <strong>Draft session active</strong>
        <span>{result.providerName} · {result.model}</span>
      </div>

      {result.warnings.length > 0 && (
        <div className="inline-warning">
          {result.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      )}

      {error && (
        <div className="error-state" role="alert">
          {error}
        </div>
      )}

      <AIDraftSummary
        summary={draftSummary}
        validationTarget={String(result.session?.metadata?.desiredValidationLevel ?? "local-valid")}
      />

      <div className="draft-section-grid">
        <DraftSectionCard title="Basics" items={draftSummary.basics} />
        <DraftSectionCard title="Skills" items={draftSummary.skills} />
        <DraftSectionCard title="Policies" items={draftSummary.policies} />
        <DraftSectionCard title="Prepared Prompts" items={draftSummary.preparedPrompts} />
        <DraftSectionCard title="Templates / Outputs" items={draftSummary.templates} />
        <DraftSectionCard title="Examples" items={draftSummary.examples} />
      </div>

      <div className="render-generated-panel">
        <h3>Request changes</h3>
        <LabelWithHelp
          htmlFor="ai-draft-change-request"
          label="Change request"
          help="Describe changes in plain language. AgentKitForge asks the provider for a full updated draft, then validates it."
        />
        <textarea
          id="ai-draft-change-request"
          onChange={(event) => onChangeRequestChange(event.target.value)}
          placeholder="Add a prepared prompt for client memos. Ask for company name and reporting period before running."
          rows={4}
          value={changeRequest}
        />
        <button
          className="primary-button"
          disabled={isRevising}
          onClick={onRequestChanges}
          type="button"
        >
          <Sparkles size={18} />
          {isRevising && <InlineSpinner className="button-spinner" />}
          {isRevising ? "Requesting changes" : "Request Changes"}
        </button>
        {isRevising && <LoadingStatus text="Asking provider for an updated draft..." />}
      </div>

      {result.session && (
        <div className="render-generated-panel">
          <h3>Revision history</h3>
          <div className="artifact-list">
            {result.session.revisions.map((revision) => (
              <article className="artifact-item" key={revision.id}>
                <div>
                  <div className="issue-code">
                    v{revision.version} {revision.version === 1 ? "Initial draft" : summarizeChangeRequest(revision.changeRequest)}
                  </div>
                  <p>{revision.createdAt ? new Date(revision.createdAt).toLocaleString() : "Saved revision"}</p>
                </div>
                <button
                  className={revision.id === result.session?.currentRevisionId ? "primary-button compact-button" : "secondary-button compact-button"}
                  onClick={() => onRestoreRevision(revision.id)}
                  type="button"
                >
                  {revision.id === result.session?.currentRevisionId ? "Current" : "Restore"}
                </button>
              </article>
            ))}
          </div>
        </div>
      )}

      <div className="button-row">
        <button className="secondary-button" onClick={onCopyJson} type="button">
          Copy JSON
        </button>
        <button className="secondary-button" onClick={onSaveJson} type="button">
          Save draft JSON
        </button>
        <button className="secondary-button" onClick={onClearSession} type="button">
          Clear Session
        </button>
      </div>

      {copyState === "copied" && <div className="copy-state">JSON copied to clipboard.</div>}
      {copyState === "failed" && (
        <div className="field-error">Clipboard access failed. Select and copy the JSON text.</div>
      )}
      {savePath && <div className="copy-state">Saved to {savePath}</div>}

      <details className="advanced-details">
        <summary>Advanced: draft JSON</summary>
        <pre className="json-panel">{result.draftJsonPretty}</pre>
      </details>

      <div className="render-generated-panel">
        <h3>Save this draft</h3>
        {onSaveUpdate && (
          <div className="inline-warning">
            Save update rewrites files for the selected Agent Kit. Use Save as new kit to keep the original unchanged.
          </div>
        )}
        <LabelWithHelp
          htmlFor="generated-render-output"
          label="Save location"
          help="Choose where the rendered kit folder should be created."
        />
        <div className="path-picker">
          <input
            id="generated-render-output"
            onChange={(event) => onRenderOutputFolderChange(event.target.value)}
            placeholder="Documents/AgentKitForge/Kits/generated-agent-kit"
            value={renderOutputFolder}
          />
          <button
            className="icon-button"
            disabled={isSelectingRenderOutput || isRenderingDraft}
            onClick={onSelectRenderOutputFolder}
            title="Select output folder"
            type="button"
          >
            <FolderOpen size={18} />
          </button>
        </div>

        <label className="checkbox-row" htmlFor="generated-render-force">
          <input
            checked={renderForce}
            id="generated-render-force"
            onChange={(event) => onRenderForceChange(event.target.checked)}
            type="checkbox"
          />
          <span>Force overwrite generated files</span>
          <HelpTip text="Use this only when you intentionally want generated files to replace existing files." />
        </label>

        <button
          className="primary-button"
          disabled={isRenderingDraft}
          onClick={onRenderDraft}
          type="button"
        >
          <FileArchive size={18} />
          {isRenderingDraft && <InlineSpinner className="button-spinner" />}
          {isRenderingDraft ? "Saving" : saveLabel}
        </button>
        {onSaveUpdate && (
          <button
            className="secondary-button"
            disabled={isRenderingDraft}
            onClick={onSaveUpdate}
            type="button"
          >
            {isRenderingDraft && <InlineSpinner className="button-spinner" />}
            {isRenderingDraft ? "Saving" : updateLabel || "Save update"}
          </button>
        )}
        {isRenderingDraft && <LoadingStatus text="Saving kit files..." />}

        {renderError && (
          <div className="error-state" role="alert">
            {renderError}
          </div>
        )}

        {renderResult && (
          <div className="create-result">
            <div className="status-banner valid">
              <strong>Rendered</strong>
              <span>{renderResult.files.length} file{renderResult.files.length === 1 ? "" : "s"}</span>
            </div>
            <details className="advanced-details">
              <summary>Advanced details</summary>
              <dl className="report-meta">
                <div>
                  <dt>Full folder path</dt>
                  <dd>{renderResult.rootPath}</dd>
                </div>
              </dl>
            </details>
            <button
              className="primary-button"
              onClick={() => onValidateRenderedKit(renderResult.rootPath)}
              type="button"
            >
              <CheckCircle2 size={18} />
              Validate rendered kit
            </button>
            <button
              className="secondary-button"
              onClick={() => onAddToMyKits(renderResult.rootPath)}
              type="button"
            >
              Add to My Kits
            </button>
            <button
              className="secondary-button"
              onClick={() => onUseKit(renderResult.rootPath)}
              type="button"
            >
              Use Kit
            </button>
            <button
              className="secondary-button"
              onClick={() => onPackageKit(renderResult.rootPath)}
              type="button"
            >
              Package / Export
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

type DraftSummary = {
  name: string;
  description: string;
  domain: string;
  targetUsers: string;
  skillsCount: number;
  policiesCount: number;
  preparedPromptsCount: number;
  templatesCount: number;
  examplesCount: number;
  basics: string[];
  skills: string[];
  policies: string[];
  preparedPrompts: string[];
  templates: string[];
  examples: string[];
};

function AIDraftSummary({
  summary,
  validationTarget,
}: {
  summary: DraftSummary;
  validationTarget: string;
}) {
  return (
    <dl className="report-meta">
      <div>
        <dt>Kit name</dt>
        <dd>{summary.name}</dd>
      </div>
      <div>
        <dt>Description</dt>
        <dd>{summary.description}</dd>
      </div>
      <div>
        <dt>Domain</dt>
        <dd>{summary.domain}</dd>
      </div>
      <div>
        <dt>Target users</dt>
        <dd>{summary.targetUsers}</dd>
      </div>
      <div>
        <dt>Skills</dt>
        <dd>{summary.skillsCount}</dd>
      </div>
      <div>
        <dt>Policies</dt>
        <dd>{summary.policiesCount}</dd>
      </div>
      <div>
        <dt>Prepared prompts</dt>
        <dd>{summary.preparedPromptsCount}</dd>
      </div>
      <div>
        <dt>Templates</dt>
        <dd>{summary.templatesCount}</dd>
      </div>
      <div>
        <dt>Examples</dt>
        <dd>{summary.examplesCount}</dd>
      </div>
      <div>
        <dt>Validation target</dt>
        <dd>{validationTarget}</dd>
      </div>
    </dl>
  );
}

function DraftSectionCard({ title, items }: { title: string; items: string[] }) {
  return (
    <article className="render-generated-panel">
      <h3>{title}</h3>
      {items.length > 0 ? (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="state-copy compact-state">Nothing defined yet.</p>
      )}
    </article>
  );
}

function currentDraftRevision(session?: AgentKitDraftSession) {
  if (!session) {
    return undefined;
  }
  return session.revisions.find((revision) => revision.id === session.currentRevisionId);
}

function summarizeAgentKitDraft(draftInput: unknown): DraftSummary {
  const draft = isRecord(draftInput) ? draftInput : {};
  const skills = arrayOfRecords(draft.skills);
  const policies = arrayOfRecords(draft.policies);
  const preparedPrompts = arrayOfRecords(draft.preparedPrompts);
  const templates = arrayOfRecords(draft.templates);
  const examples = arrayOfRecords(draft.examples);
  const name = stringValue(draft.name, "Untitled Agent Kit");
  const description = stringValue(draft.description, "No description yet.");
  const metadata = isRecord(draft.metadata) ? draft.metadata : {};
  const domain = stringValue(draft.domain, stringValue(metadata.domain, "Not specified"));
  const targetUsers = formatUnknownList(draft.targetUsers) || formatUnknownList(metadata.targetUsers) || "Not specified";

  return {
    name,
    description,
    domain,
    targetUsers,
    skillsCount: skills.length,
    policiesCount: policies.length,
    preparedPromptsCount: preparedPrompts.length,
    templatesCount: templates.length,
    examplesCount: examples.length,
    basics: [
      `Name: ${name}`,
      `ID: ${stringValue(draft.id, "Not set")}`,
      `Version: ${stringValue(draft.version, "Not set")}`,
      `Description: ${description}`,
    ],
    skills: skills.map((skill) => `${stringValue(skill.name, stringValue(skill.id, "Unnamed skill"))}: ${stringValue(skill.description, "No description")}`),
    policies: policies.map((policy) => stringValue(policy.name, stringValue(policy.id, stringValue(policy.description, "Policy")))),
    preparedPrompts: preparedPrompts.map((prompt) => `${stringValue(prompt.name, stringValue(prompt.id, "Prepared prompt"))}${prompt.documentLikeOutput === true ? " (document output)" : ""}`),
    templates: templates.map((template) => stringValue(template.name, stringValue(template.id, stringValue(template.path, "Template")))),
    examples: examples.map((example) => stringValue(example.name, stringValue(example.id, stringValue(example.prompt, "Example")))),
  };
}

function summarizeChangeRequest(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "Updated draft";
  }
  return trimmed.length > 70 ? `${trimmed.slice(0, 67)}...` : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayOfRecords(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function formatUnknownList(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").join(", ");
  }
  return typeof value === "string" ? value.trim() : "";
}

function FieldError({ message }: { message?: string }) {
  if (!message) {
    return null;
  }

  return <div className="field-error">{message}</div>;
}

function InlineSpinner({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`inline-spinner ${className}`} />;
}

function LoadingStatus({ text }: { text: string }) {
  return (
    <div className="loading-status" role="status" aria-live="polite">
      <InlineSpinner />
      <span>{text}</span>
    </div>
  );
}

function validateCreateForm(form: CreateAgentKitInput) {
  const errors: Partial<Record<keyof CreateAgentKitInput, string>> = {};

  if (form.outputFolder.trim() === "") {
    errors.outputFolder = "Output folder is required.";
  }

  if (form.id.trim() === "") {
    errors.id = "Kit id is required.";
  } else if (!/^[A-Za-z0-9_-]+$/.test(form.id.trim())) {
    errors.id = "Use letters, numbers, dashes, and underscores only.";
  }

  if (form.name.trim() === "") {
    errors.name = "Kit name is required.";
  }

  if (form.description.trim() === "") {
    errors.description = "Kit description is required.";
  }

  if (!agentKitTemplates.includes(form.template)) {
    errors.template = "Template is required.";
  }

  return errors;
}

function validateDraftRenderForm(form: RenderAgentKitDraftInput) {
  const errors: Partial<Record<keyof RenderAgentKitDraftInput, string>> = {};

  if (form.draftFilePath.trim() === "") {
    errors.draftFilePath = "Draft JSON file is required.";
  }

  if (form.outputFolder.trim() === "") {
    errors.outputFolder = "Output folder is required.";
  }

  return errors;
}

function validateGenerateDraftForm(settings: PublicSettings, form: GenerateAgentKitDraftInput) {
  const errors: Partial<Record<keyof GenerateAgentKitDraftInput | "apiKey", string>> = {};

  if (settings.aiProviders.length === 0) {
    errors.apiKey = "AI provider is required. Add one in Settings first.";
  }

  if (form.providerId.trim() === "") {
    errors.providerId = "AI provider is required.";
  }

  if (form.userRequest.trim() === "") {
    errors.userRequest = "Describe the Agent Kit you want.";
  }

  if (!validationProfiles.includes(form.desiredValidationLevel)) {
    errors.desiredValidationLevel = "Desired validation level is required.";
  }

  return errors;
}

function defaultValidationProfileForTemplate(template: AgentKitTemplate): ValidationProfile {
  return template === "financial-review" ? "trusted" : "local-valid";
}

function ValidationResults({
  error,
  isLoading,
  report,
}: {
  error: string | null;
  isLoading: boolean;
  report: ValidationReport | null;
}) {
  if (isLoading) {
    return <LoadingStatus text="Validating kit..." />;
  }

  if (error) {
    return (
      <div className="error-state" role="alert">
        {error}
      </div>
    );
  }

  if (!report) {
    return <p className="state-copy">Run a check to see whether this kit needs attention.</p>;
  }

  const issuesBySeverity = groupIssuesBySeverity(report.issues);

  return (
    <div className="validation-report">
      <div className={`status-banner ${report.valid ? "valid" : "invalid"}`}>
        <strong>{report.valid ? "Valid" : "Needs attention"}</strong>
        <span>{report.issues.length} issue{report.issues.length === 1 ? "" : "s"}</span>
      </div>

      <dl className="report-meta">
        <div>
          <dt>Profile</dt>
          <dd>{report.profile}</dd>
        </div>
        <div>
          <dt>Root path</dt>
          <dd>{friendlyLocation(report.rootPath)}</dd>
        </div>
      </dl>
      <details className="advanced-details">
        <summary>Show full path</summary>
        <p className="inline-code">{report.rootPath}</p>
      </details>

      {report.issues.length === 0 ? (
        <p className="state-copy">No validation issues found.</p>
      ) : (
        <div className="issue-groups">
          {(["error", "warning"] as ValidationIssueSeverity[]).map((severity) => (
            <IssueGroup issues={issuesBySeverity[severity]} key={severity} severity={severity} />
          ))}
        </div>
      )}
    </div>
  );
}

function IssueGroup({
  issues,
  severity,
}: {
  issues: ValidationIssue[];
  severity: ValidationIssueSeverity;
}) {
  if (issues.length === 0) {
    return null;
  }

  return (
    <section className="issue-group">
      <h3>
        {severity}
        <span>{issues.length}</span>
      </h3>
      <ul>
        {issues.map((issue, index) => (
          <li key={`${issue.code}-${issue.path ?? "root"}-${index}`}>
            <div className="issue-code">{issue.code}</div>
            <p>{friendlyValidationIssue(issue)}</p>
            {issue.path && <div className="issue-path">{issue.path}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function friendlyValidationIssue(issue: ValidationIssue) {
  if (issue.code === "skill.required.missing") {
    return "Add at least one skill before sharing or using this kit.";
  }
  if (issue.code === "manifest.skill_path.missing") {
    return "A skill listed in the kit manifest is missing from the kit folder.";
  }
  if (issue.code.includes("required") || issue.code.includes("missing")) {
    return `${issue.message} Add the missing item or regenerate the kit.`;
  }
  return issue.message;
}

function groupIssuesBySeverity(issues: ValidationIssue[]) {
  return issues.reduce<Record<ValidationIssueSeverity, ValidationIssue[]>>(
    (grouped, issue) => {
      grouped[issue.severity].push(issue);
      return grouped;
    },
    { error: [], warning: [] },
  );
}

function errorToMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "Unexpected validation error.";
}

function PlaceholderCard({
  description,
  icon: Icon,
  title,
}: {
  description: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  title: string;
}) {
  return (
    <article className="placeholder-card">
      <div className="card-icon">
        <Icon size={22} strokeWidth={1.9} />
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      <button className="secondary-button" type="button">
        Configure
      </button>
    </article>
  );
}
