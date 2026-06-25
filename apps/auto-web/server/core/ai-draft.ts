// AI draft generation/revision — ported from the desktop
// generate-agent-kit-draft.mjs bridge.
//
// Provider config is resolved from the CURRENT USER's server-side settings
// (see server/store/user-settings.ts), so each user supplies their own provider
// + API key and keys never reach the browser. (A single-provider env fallback,
// AGENTKITFORGE_AI_PROVIDER_CONFIG, is kept for headless/dev use.)
//
// Supports the same provider types as the desktop app: openai, anthropic,
// gemini, ollama, openai-compatible. (Verified against the published Anthropic
// Messages API shape used by the desktop bridge.)
import { loadCore } from "@/server/core/load-core";
import { getUserSettingsStore } from "@/server/store/user-settings";
import { runManagedChat } from "@/server/core/gateway";
import { MANAGED_DEFAULT_MODEL, isManagedModel } from "@/server/core/managed-models";
import type { ChatRequest } from "@agentkitforge/gateway-core";

const MANAGED_MAX_TOKENS = 4000;

// Billing mode selection: a user with ANY configured BYO provider uses BYO
// (their own key, ledger untouched); otherwise managed prepaid credits.
type BillingResolution =
  | { mode: "byo"; provider: ProviderConfig; model: string }
  | { mode: "managed"; model: string };

type ProviderConfig = {
  id?: string;
  name: string;
  providerType: "openai" | "anthropic" | "gemini" | "ollama" | "openai-compatible";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  defaultModel?: string;
};

// Core expects array fields; the UI sends either a string or an array.
function toList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  const trimmed = value.trim();
  return trimmed ? [trimmed] : undefined;
}

function normalizeProviderConfig(parsed: ProviderConfig): ProviderConfig {
  return {
    ...parsed,
    name: parsed.name?.trim() || parsed.providerType,
    baseUrl: parsed.baseUrl?.trim().replace(/\/+$/, "") || undefined,
    apiKey: parsed.apiKey?.trim() || undefined,
    defaultModel: parsed.defaultModel?.trim() || ""
  };
}

// Resolve the provider config for a user: prefer their stored provider (default
// or the requested id, key decrypted), else fall back to the server env config.
async function resolveProviderConfig(userId: string, providerId?: string): Promise<ProviderConfig> {
  const stored = await (await getUserSettingsStore()).resolveProvider(userId, providerId);
  if (stored) {
    return normalizeProviderConfig({
      id: stored.id,
      name: stored.name,
      providerType: stored.providerType,
      baseUrl: stored.baseUrl,
      apiKey: stored.apiKey,
      defaultModel: stored.defaultModel
    });
  }
  const raw = process.env.AGENTKITFORGE_AI_PROVIDER_CONFIG;
  if (raw) return normalizeProviderConfig(JSON.parse(raw) as ProviderConfig);
  throw new Error("No AI provider configured. Add a provider in Settings before generating a draft.");
}

// Resolve which billing path a turn uses. If the user has a BYO provider
// configured (or the requested one resolves), use it. Otherwise fall back to
// MANAGED prepaid credits using the platform Anthropic key.
async function resolveBilling(
  userId: string,
  providerId: string | undefined,
  inputModel: string | undefined
): Promise<BillingResolution> {
  const stored = await (await getUserSettingsStore()).resolveProvider(userId, providerId);
  if (stored) {
    const provider = normalizeProviderConfig({
      id: stored.id,
      name: stored.name,
      providerType: stored.providerType,
      baseUrl: stored.baseUrl,
      apiKey: stored.apiKey,
      defaultModel: stored.defaultModel
    });
    const model = resolveModel(provider, inputModel);
    if (!model) throw new Error(`${provider.name} model is required.`);
    return { mode: "byo", provider, model };
  }
  // Env single-provider fallback (headless/dev) still counts as BYO.
  const raw = process.env.AGENTKITFORGE_AI_PROVIDER_CONFIG;
  if (raw) {
    const provider = normalizeProviderConfig(JSON.parse(raw) as ProviderConfig);
    const model = resolveModel(provider, inputModel);
    if (!model) throw new Error(`${provider.name} model is required.`);
    return { mode: "byo", provider, model };
  }
  // No BYO provider configured → managed prepaid credits. Only honor a
  // requested model if it is one we actually offer + price; otherwise fall back
  // to the balanced default (never bill against an unknown/arbitrary id).
  const requested = inputModel?.trim();
  return { mode: "managed", model: isManagedModel(requested) ? requested! : MANAGED_DEFAULT_MODEL };
}

// Build the gateway ChatRequest for a draft turn from the same prompt parts the
// BYO callProvider() uses, then run it through the credit-gated managed flow.
async function callManagedProvider(
  userId: string,
  model: string,
  draftRequest: DraftRequestLike,
  sourceRef: string
): Promise<string> {
  const input = [
    draftRequest.builderInstructions,
    "",
    draftRequest.userPrompt,
    "",
    "Return only valid AgentKitDraft JSON.",
    "Expected JSON schema:",
    JSON.stringify(draftRequest.expectedJsonSchema)
  ].join("\n");
  const request: ChatRequest = {
    model,
    system: draftRequest.systemInstructions,
    messages: [{ role: "user", content: [{ type: "text", text: input }] }],
    tools: [],
    maxTokens: MANAGED_MAX_TOKENS
  };
  // Rough input-token estimate (~4 chars/token) to size the conservative hold.
  const estimatedInputTokens = Math.ceil((draftRequest.systemInstructions.length + input.length) / 4);
  const { response } = await runManagedChat(userId, request, { estimatedInputTokens, sourceRef });
  const text = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text) throw new Error("Managed inference returned an empty draft response.");
  return text;
}

function resolveModel(provider: ProviderConfig, inputModel?: string): string {
  return (
    [inputModel, provider.model, provider.defaultModel]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .find((v) => v.length > 0) ?? ""
  );
}

function normalizeSecureBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Base URL must start with http:// or https://.");
  }
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (parsed.protocol === "http:" && !isLocal) {
    throw new Error("Non-local HTTP providers may leak prompts/keys. Use HTTPS or a local address.");
  }
  return value.replace(/\/+$/, "");
}

function providerErrorMessage(name: string, status: number, body: string): string {
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message || parsed?.error;
    if (message) return `${name} request failed (${status}): ${message}`;
  } catch {
    // fall through
  }
  return `${name} request failed (${status}).`;
}

type DraftRequestLike = {
  systemInstructions: string;
  builderInstructions: string;
  userPrompt: string;
  expectedJsonSchema: unknown;
  responseFormatName: string;
  warnings?: unknown;
};

async function callProvider(provider: ProviderConfig, model: string, draftRequest: DraftRequestLike): Promise<string> {
  const instructions = draftRequest.systemInstructions;
  const input = [
    draftRequest.builderInstructions,
    "",
    draftRequest.userPrompt,
    "",
    "Return only valid AgentKitDraft JSON.",
    "Expected JSON schema:",
    JSON.stringify(draftRequest.expectedJsonSchema)
  ].join("\n");

  switch (provider.providerType) {
    case "anthropic": {
      const baseUrl = normalizeSecureBaseUrl(provider.baseUrl || "https://api.anthropic.com/v1");
      const res = await fetch(`${baseUrl}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": requiredKey(provider),
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          system: instructions,
          messages: [{ role: "user", content: input }],
          max_tokens: 4000
        })
      });
      const body = await res.text();
      if (!res.ok) throw new Error(providerErrorMessage(provider.name, res.status, body));
      const parsed = JSON.parse(body);
      const text = (parsed.content ?? [])
        .map((item: { text?: string }) => item.text)
        .filter(Boolean)
        .join("\n")
        .trim();
      if (!text) throw new Error("Anthropic returned an empty draft response.");
      return text;
    }
    case "openai":
    case "openai-compatible": {
      const baseUrl = normalizeSecureBaseUrl(provider.baseUrl || "https://api.openai.com/v1");
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: instructions },
            { role: "user", content: input }
          ],
          temperature: 0.2
        })
      });
      const body = await res.text();
      if (!res.ok) throw new Error(providerErrorMessage(provider.name, res.status, body));
      const parsed = JSON.parse(body);
      const text = parsed?.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error(`${provider.name} returned an empty draft response.`);
      return text;
    }
    case "gemini": {
      const baseUrl = normalizeSecureBaseUrl(provider.baseUrl || "https://generativelanguage.googleapis.com/v1beta");
      const res = await fetch(
        `${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(requiredKey(provider))}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${instructions}\n\n${input}` }] }],
            generationConfig: { maxOutputTokens: 4000 }
          })
        }
      );
      const body = await res.text();
      if (!res.ok) throw new Error(providerErrorMessage(provider.name, res.status, body));
      const parsed = JSON.parse(body);
      const text = (parsed.candidates ?? [])
        .flatMap((c: { content?: { parts?: { text?: string }[] } }) => c.content?.parts ?? [])
        .map((p: { text?: string }) => p.text)
        .filter(Boolean)
        .join("\n")
        .trim();
      if (!text) throw new Error("Gemini returned an empty draft response.");
      return text;
    }
    case "ollama": {
      const baseUrl = normalizeSecureBaseUrl(provider.baseUrl || "http://localhost:11434");
      const res = await fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, system: instructions, prompt: input, stream: false, options: { num_predict: 4000 } })
      });
      const body = await res.text();
      if (!res.ok) throw new Error(providerErrorMessage(provider.name, res.status, body));
      const parsed = JSON.parse(body);
      const text = parsed.response?.trim();
      if (!text) throw new Error("Ollama returned an empty draft response.");
      return text;
    }
    default:
      throw new Error(`Unsupported AI provider type: ${provider.providerType}`);
  }
}

function requiredKey(provider: ProviderConfig): string {
  if (!provider.apiKey) throw new Error(`${provider.name} API key is required.`);
  return provider.apiKey;
}

// Parse the first AgentKitDraft-valid JSON object out of the model text.
async function parseDraft(core: Awaited<ReturnType<typeof loadCore>>, text: string) {
  const trimmed = String(text ?? "").trim();
  const candidates: unknown[] = [];
  const push = (value: string) => {
    try {
      candidates.push(JSON.parse(value));
    } catch {
      /* keep looking */
    }
  };
  push(trimmed);
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) push(match[1]);

  for (const candidate of candidates) {
    const obj = candidate as Record<string, unknown>;
    const unwrapped =
      obj && typeof obj === "object"
        ? (["draftJson", "draft", "agentKitDraft", "agentKit", "result"]
            .map((k) => obj[k])
            .find((v) => v && typeof v === "object") ?? obj)
        : candidate;
    const parsed = core.agentKitDraftSchema.safeParse(unwrapped);
    if (parsed.success) return parsed.data;
  }
  throw new Error("Provider returned no valid AgentKitDraft JSON. Try regenerating or a stricter model.");
}

export type GenerateDraftInput = {
  userRequest: string;
  targetUsers?: string | string[];
  domain?: string;
  desiredValidationLevel?: string;
  constraints?: string | string[];
  sourceNotes?: string | string[];
  requestedSections?: string[];
  excludedSections?: string[];
  exampleInputDocuments?: unknown[];
  model?: string;
  /** Optional explicit provider id; otherwise the user's default is used. */
  providerId?: string;
};

export async function generateDraft(userId: string, input: GenerateDraftInput) {
  const billing = await resolveBilling(userId, input.providerId, input.model);
  const core = await loadCore();
  const draftRequest = core.createAgentKitDraftRequest({
    userRequest: input.userRequest,
    targetUsers: toList(input.targetUsers),
    domain: input.domain,
    desiredValidationLevel: input.desiredValidationLevel as never,
    constraints: toList(input.constraints),
    sourceNotes: toList(input.sourceNotes),
    requestedSections: input.requestedSections,
    excludedSections: input.excludedSections,
    exampleInputDocuments: input.exampleInputDocuments as never
  }) as unknown as DraftRequestLike;
  const providerName = billing.mode === "byo" ? billing.provider.name : "Managed credits";
  const rawText =
    billing.mode === "byo"
      ? await callProvider(billing.provider, billing.model, draftRequest)
      : await callManagedProvider(userId, billing.model, draftRequest, "draft.generate");
  const draft = await parseDraft(core, rawText);
  const session = core.createDraftSession({
    originalRequest: input.userRequest,
    initialDraft: draft,
    provider: providerName,
    model: billing.model,
    warnings: draftRequest.warnings as never,
    name: draft.name
  });
  return {
    draftJson: draft,
    warnings: draftRequest.warnings,
    providerName,
    model: billing.model,
    billingMode: billing.mode,
    session,
    currentRevision: core.getCurrentDraftRevision(session)
  };
}

export type ReviseDraftInput = {
  session: unknown;
  changeRequest: string;
  desiredValidationLevel?: string;
  constraints?: string | string[];
  sourceNotes?: string | string[];
  requestedSections?: string[];
  excludedSections?: string[];
  exampleInputDocuments?: unknown[];
  model?: string;
  providerId?: string;
};

export async function reviseDraft(userId: string, input: ReviseDraftInput) {
  const billing = await resolveBilling(userId, input.providerId, input.model);
  const core = await loadCore();
  const session = core.validateDraftSession(input.session);
  const currentRevision = core.getCurrentDraftRevision(session);
  const revisionRequest = core.createAgentKitDraftRevisionRequest({
    currentDraft: currentRevision.draft,
    changeRequest: input.changeRequest,
    originalRequest: session.originalRequest,
    desiredValidationLevel: input.desiredValidationLevel as never,
    constraints: toList(input.constraints),
    sourceNotes: toList(input.sourceNotes),
    requestedSections: input.requestedSections,
    excludedSections: input.excludedSections,
    exampleInputDocuments: input.exampleInputDocuments as never
  }) as unknown as DraftRequestLike;
  const providerName = billing.mode === "byo" ? billing.provider.name : "Managed credits";
  const rawText =
    billing.mode === "byo"
      ? await callProvider(billing.provider, billing.model, revisionRequest)
      : await callManagedProvider(userId, billing.model, revisionRequest, "draft.revise");
  const draft = await parseDraft(core, rawText);
  const updatedSession = core.addDraftRevision(session, {
    draft,
    changeRequest: input.changeRequest,
    provider: providerName,
    model: billing.model,
    warnings: revisionRequest.warnings as never
  });
  return {
    draftJson: draft,
    warnings: revisionRequest.warnings,
    providerName,
    model: billing.model,
    billingMode: billing.mode,
    session: updatedSession,
    currentRevision: core.getCurrentDraftRevision(updatedSession)
  };
}

// Lightweight connectivity/credentials check for a configured provider. Sends a
// trivial prompt and reports success/failure without parsing a draft.
export async function testProvider(
  userId: string,
  input: { providerId?: string; model?: string }
): Promise<{ ok: boolean; model: string; message: string }> {
  const provider = await resolveProviderConfig(userId, input.providerId);
  const model = resolveModel(provider, input.model);
  if (!model) return { ok: false, model: "", message: `${provider.name} model is required.` };
  const draftRequest: DraftRequestLike = {
    systemInstructions: "You are a connectivity probe. Reply with the single word OK.",
    builderInstructions: "Connectivity check.",
    userPrompt: "Reply with OK.",
    expectedJsonSchema: {},
    responseFormatName: "probe"
  };
  try {
    const text = await callProvider(provider, model, draftRequest);
    return { ok: true, model, message: `${provider.name} responded (${text.slice(0, 40)}).` };
  } catch (error) {
    return { ok: false, model, message: error instanceof Error ? error.message : String(error) };
  }
}
