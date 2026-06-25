import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeSecureBaseUrl, redactUserVisibleError } from "./security-utils.mjs";

const [, , actionOrInputJson, maybeInputJson] = process.argv;
const providerJson = process.env.AGENTKITFORGE_AI_PROVIDER_CONFIG;
const action = maybeInputJson ? actionOrInputJson : "generate";
const inputJson = maybeInputJson ?? actionOrInputJson;

if (isMainModule()) {
  await main();
}

async function main() {
  if (!inputJson) {
    console.error("Draft generation input is required.");
    process.exit(2);
  }

  if (!providerJson) {
    console.error("AI provider configuration is required.");
    process.exit(2);
  }

  try {
    const input = JSON.parse(inputJson);
    const provider = normalizeProviderConfig(JSON.parse(providerJson));
    const core = await loadCore();
    const model = resolveModel(provider, input.model);
    logProviderDiagnostics(provider, model);
    validateProviderConfig(provider, model);

    if (action === "revise") {
      const session = core.validateDraftSession(input.session);
      const currentRevision = core.getCurrentDraftRevision(session);
      const revisionRequest = core.createAgentKitDraftRevisionRequest({
        currentDraft: currentRevision.draft,
        changeRequest: input.changeRequest,
        originalRequest: session.originalRequest,
        desiredValidationLevel: input.desiredValidationLevel,
        constraints: input.constraints,
        sourceNotes: input.sourceNotes,
        requestedSections: input.requestedSections,
        excludedSections: input.excludedSections,
        exampleInputDocuments: input.exampleInputDocuments,
      });
      const rawText = await callProvider(provider, model, revisionRequest);
      const draft = parseAgentKitDraftFromProviderText(core, rawText);
      const updatedSession = core.addDraftRevision(session, {
        draft,
        changeRequest: input.changeRequest,
        provider: provider.name,
        model,
        warnings: revisionRequest.warnings,
      });
      writeDraftResult({
        draft,
        warnings: revisionRequest.warnings,
        provider,
        model,
        rawResponse: null,
        session: updatedSession,
        currentRevision: core.getCurrentDraftRevision(updatedSession),
      });
      process.exit(0);
    }

    if (action !== "generate") {
      throw new Error(`Unsupported draft action: ${action}`);
    }

    const draftRequest = core.createAgentKitDraftRequest({
      userRequest: input.userRequest,
      targetUsers: input.targetUsers,
      domain: input.domain,
      desiredValidationLevel: input.desiredValidationLevel,
      constraints: input.constraints,
      sourceNotes: input.sourceNotes,
      requestedSections: input.requestedSections,
      excludedSections: input.excludedSections,
      exampleInputDocuments: input.exampleInputDocuments,
    });
    const rawText = await callProvider(provider, model, draftRequest);
    const draft = parseAgentKitDraftFromProviderText(core, rawText);
    const session = core.createDraftSession({
      originalRequest: input.userRequest,
      initialDraft: draft,
      provider: provider.name,
      model,
      warnings: draftRequest.warnings,
      name: draft.name,
      metadata: {
        domain: input.domain,
        targetUsers: input.targetUsers,
        desiredValidationLevel: input.desiredValidationLevel,
      },
    });
    writeDraftResult({
      draft,
      warnings: draftRequest.warnings,
      provider,
      model,
      rawResponse: null,
      session,
      currentRevision: core.getCurrentDraftRevision(session),
    });
  } catch (error) {
    console.error(redactUserVisibleError(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function parseAgentKitDraft(core, draftJson) {
  const normalizedDraft = normalizeDraftCandidate(draftJson);
  const parsed = core.agentKitDraftSchema.safeParse(normalizedDraft);

  if (!parsed.success) {
    throw draftValidationError(parsed.error, normalizedDraft);
  }

  return parsed.data;
}

export function parseAgentKitDraftFromProviderText(core, text) {
  const candidates = parseJsonCandidates(text);
  let firstValidationError = null;
  let firstCandidate = undefined;

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeDraftCandidate(candidate);
    const parsed = core.agentKitDraftSchema.safeParse(normalizedCandidate);
    if (parsed.success) {
      return parsed.data;
    }
    firstValidationError ??= parsed.error;
    firstCandidate ??= normalizedCandidate;
  }

  if (firstValidationError) {
    throw draftValidationError(firstValidationError, firstCandidate);
  }

  throw new Error("Provider returned non-JSON for draft generation. Try regenerating, use a stricter model, or render a draft JSON manually.");
}

function normalizeDraftCandidate(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return candidate;
  }

  for (const key of ["draftJson", "draft", "agentKitDraft", "agentKit", "result"]) {
    if (candidate[key] && typeof candidate[key] === "object" && !Array.isArray(candidate[key])) {
      return candidate[key];
    }
  }

  return candidate;
}

function parseJsonCandidates(text) {
  const candidates = [];
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return candidates;
  }

  pushJsonCandidate(candidates, trimmed);

  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    pushJsonCandidate(candidates, match[1]);
  }

  for (const slice of balancedJsonSlices(trimmed)) {
    pushJsonCandidate(candidates, slice);
  }

  return candidates;
}

function pushJsonCandidate(candidates, value) {
  try {
    const parsed = JSON.parse(value);
    if (!candidates.some((candidate) => JSON.stringify(candidate) === JSON.stringify(parsed))) {
      candidates.push(parsed);
    }
  } catch {
    // Keep looking for a valid JSON candidate.
  }
}

function balancedJsonSlices(text) {
  const slices = [];
  const starts = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "{") {
      starts.push(index);
    }
  }

  for (const start of starts.slice(0, 20)) {
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (character === "\\") {
        escapeNext = true;
        continue;
      }
      if (character === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          slices.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }

  return slices;
}

function draftValidationError(error, draftJson) {
  const issues = error.issues
    .flatMap(expandZodIssue)
    .slice(0, 12)
    .map((issue) => {
      const issuePath = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${issuePath}: ${issue.message}`;
    })
    .join("\n");
  return new Error(`Generated draft did not match the AgentKitDraft schema:\n${issues}\nGenerated JSON summary: ${summarizeJsonForDiagnostics(draftJson)}`);
}

function expandZodIssue(issue) {
  if (issue.code === "invalid_union" && Array.isArray(issue.errors)) {
    return issue.errors.flat().map((nested) => ({
      ...nested,
      path: nested.path?.length ? nested.path : issue.path,
    }));
  }
  return [issue];
}

export function summarizeJsonForDiagnostics(value) {
  if (Array.isArray(value)) {
    return `array length=${value.length}`;
  }
  if (!value || typeof value !== "object") {
    return `${typeof value}`;
  }
  const keys = Object.keys(value).slice(0, 12);
  return `object keys=${keys.join(",") || "(none)"}`;
}

function writeDraftResult({ draft, warnings, provider, model, rawResponse, session, currentRevision }) {
  process.stdout.write(
    JSON.stringify({
      draftJson: draft,
      draftJsonPretty: `${JSON.stringify(draft, null, 2)}\n`,
      warnings,
      providerId: provider.id,
      providerName: provider.name,
      model,
      rawResponse,
      session,
      currentRevision,
    }),
  );
}

async function callProvider(provider, model, draftRequest) {
  const instructions = draftRequest.systemInstructions;
  const input = [
    draftRequest.builderInstructions,
    "",
    draftRequest.userPrompt,
    "",
    "Return only valid AgentKitDraft JSON.",
    "Expected JSON schema:",
    JSON.stringify(draftRequest.expectedJsonSchema),
  ].join("\n");

  switch (provider.providerType) {
    case "openai":
      return callOpenAIResponses(provider, model, instructions, input, draftRequest);
    case "anthropic":
      return callAnthropic(provider, model, instructions, input);
    case "gemini":
      return callGemini(provider, model, instructions, input);
    case "ollama":
      return callOllama(provider, model, instructions, input);
    case "openai-compatible":
      return callOpenAICompatible(provider, model, instructions, input);
    default:
      throw new Error(`Unsupported AI provider type: ${provider.providerType}`);
  }
}

async function callOpenAIResponses(provider, model, instructions, input, draftRequest) {
  const apiKey = requiredApiKey(provider);
  const baseUrl = normalizedBaseUrl(provider.baseUrl || "https://api.openai.com/v1");
  const response = await fetchProvider(provider, `${baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions,
      input,
      text: {
        format: {
          type: "json_schema",
          name: draftRequest.responseFormatName,
          schema: draftRequest.expectedJsonSchema,
          strict: false,
        },
      },
    }),
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(providerErrorMessage(provider.name, response.status, body));
  }

  return extractOpenAIResponseText(JSON.parse(body), provider.name);
}

async function callOpenAICompatible(provider, model, instructions, input) {
  const baseUrl = normalizedBaseUrl(requiredBaseUrl(provider));
  const headers = { "Content-Type": "application/json" };
  if (isPresentSecret(provider.apiKey)) {
    headers.Authorization = `Bearer ${provider.apiKey.trim()}`;
  }
  const response = await fetchProvider(provider, `${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: input },
      ],
      temperature: 0.2,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(providerErrorMessage(provider.name, response.status, body));
  }
  const parsed = JSON.parse(body);
  const text = parsed?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`${provider.name} returned an empty draft response.`);
  return text;
}

async function callAnthropic(provider, model, instructions, input) {
  const apiKey = requiredApiKey(provider);
  const baseUrl = normalizedBaseUrl(provider.baseUrl || "https://api.anthropic.com/v1");
  const response = await fetchProvider(provider, `${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      system: instructions,
      messages: [{ role: "user", content: input }],
      max_tokens: 4000,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(providerErrorMessage(provider.name, response.status, body));
  }
  const parsed = JSON.parse(body);
  const text = (parsed.content ?? []).map((item) => item.text).filter(Boolean).join("\n").trim();
  if (!text) throw new Error("Anthropic returned an empty draft response.");
  return text;
}

async function callGemini(provider, model, instructions, input) {
  const apiKey = requiredApiKey(provider);
  const baseUrl = normalizedBaseUrl(provider.baseUrl || "https://generativelanguage.googleapis.com/v1beta");
  const response = await fetchProvider(provider, `${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${instructions}\n\n${input}` }] }],
      generationConfig: { maxOutputTokens: 4000 },
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(providerErrorMessage(provider.name, response.status, body));
  }
  const parsed = JSON.parse(body);
  const text = (parsed.candidates ?? [])
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text) throw new Error("Gemini returned an empty draft response.");
  return text;
}

async function callOllama(provider, model, instructions, input) {
  const baseUrl = normalizedBaseUrl(provider.baseUrl || "http://localhost:11434");
  const response = await fetchProvider(provider, `${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      system: instructions,
      prompt: input,
      stream: false,
      options: { num_predict: 4000 },
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(providerErrorMessage(provider.name, response.status, body));
  }
  const parsed = JSON.parse(body);
  const text = parsed.response?.trim();
  if (!text) throw new Error("Ollama returned an empty draft response.");
  return text;
}

function extractOpenAIResponseText(response, providerName) {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }

  const text = (response.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === "output_text" || content.type === "text")
    .map((content) => content.text)
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error(`${providerName} returned an empty draft response.`);
  }

  return text;
}

export function providerErrorMessage(providerName, status, body) {
  if (providerName === "OpenAI" && status === 401) {
    return "OpenAI API key is invalid. Check the key in Settings.";
  }
  if (providerName === "OpenAI" && status === 403) {
    return "OpenAI request was denied. Check account, project, model, or provider permissions.";
  }

  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message || parsed?.error;
    if (message) {
      return `${providerName} request failed (${status}): ${message}`;
    }
  } catch {
    // Fall through to generic message.
  }

  return `${providerName} request failed (${status}).`;
}

function requiredApiKey(provider) {
  if (!isPresentSecret(provider.apiKey)) {
    throw new Error(missingApiKeyMessage(provider));
  }
  return provider.apiKey.trim();
}

function requiredBaseUrl(provider) {
  if (!provider.baseUrl?.trim()) {
    throw new Error(`${provider.name} base URL is required.`);
  }
  return provider.baseUrl;
}

function normalizedBaseUrl(value) {
  return normalizeSecureBaseUrl(value);
}

export function normalizeProviderConfig(provider) {
  return {
    ...provider,
    name: isPresentConfigValue(provider?.name) ? provider.name.trim() : providerNameForType(provider?.providerType),
    baseUrl: isPresentConfigValue(provider?.baseUrl) ? provider.baseUrl.trim().replace(/\/+$/, "") : defaultBaseUrl(provider?.providerType),
    apiKey: isPresentSecret(provider?.apiKey) ? provider.apiKey.trim() : undefined,
    model: isPresentConfigValue(provider?.model) ? provider.model.trim() : undefined,
    defaultModel: isPresentConfigValue(provider?.defaultModel)
      ? provider.defaultModel.trim()
      : "",
  };
}

export function resolveModel(provider, inputModel) {
  return [inputModel, provider.model, provider.defaultModel]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => isPresentConfigValue(value)) ?? "";
}

export function validateProviderConfig(provider, model) {
  if (!["openai", "anthropic", "gemini", "ollama", "openai-compatible"].includes(provider.providerType)) {
    throw new Error(`Unsupported AI provider type: ${provider.providerType}`);
  }

  if (!isPresentConfigValue(model)) {
    throw new Error(missingModelMessage(provider));
  }

  if (provider.providerType !== "ollama" && !isPresentSecret(provider.apiKey)) {
    throw new Error(missingApiKeyMessage(provider));
  }

  if ((provider.providerType === "openai-compatible" || provider.providerType === "ollama") && !isPresentConfigValue(provider.baseUrl)) {
    throw new Error(`${provider.name} base URL is required.`);
  }

  if (isPresentConfigValue(provider.baseUrl)) {
    normalizedBaseUrl(provider.baseUrl);
  }
}

async function fetchProvider(provider, url, options) {
  try {
    return await fetch(url, options);
  } catch (error) {
    throw new Error(fetchFailedMessage(provider, error));
  }
}

export function fetchFailedMessage(provider, error) {
  const cause = error?.cause;
  const causeParts = [
    cause?.code,
    cause?.name,
    cause?.message,
  ].filter((part) => typeof part === "string" && part.trim());
  const fallbackParts = [
    error?.name,
    error?.message && error.message !== "fetch failed" ? error.message : undefined,
  ].filter((part) => typeof part === "string" && part.trim());
  const details = causeParts.length > 0 ? causeParts : fallbackParts;
  const detailText = details.length > 0 ? ` Detail: ${details.join(": ")}.` : "";
  return `${provider.name} network request failed before receiving an HTTP response.${detailText}`;
}

function logProviderDiagnostics(provider, model) {
  const keyLength = isPresentSecret(provider.apiKey) ? provider.apiKey.trim().length : 0;
  console.error(
    [
      "AgentKitForge Build with AI provider config:",
      `selectedProviderId=${provider.id ?? ""}`,
      `providerType=${provider.providerType ?? ""}`,
      `baseUrl=${provider.baseUrl ?? ""}`,
      `resolvedModel=${model}`,
      `apiKeyPresent=${keyLength > 0}`,
      `apiKeyLength=${keyLength}`,
      `apiKeySource=${provider.apiKeySource ?? "unknown"}`,
    ].join(" "),
  );
}

function missingApiKeyMessage(provider) {
  switch (provider.providerType) {
    case "openai":
      return "OpenAI API key is missing. Add it in Settings.";
    case "anthropic":
      return "Anthropic API key is missing. Add it in Settings.";
    case "gemini":
      return "Gemini API key is missing. Add it in Settings.";
    default:
      return `${provider.name} API key is missing. Add it in Settings.`;
  }
}

function missingModelMessage(provider) {
  switch (provider.providerType) {
    case "openai":
      return "OpenAI model is missing. Select a model in Settings.";
    case "anthropic":
      return "Anthropic model is missing. Select a model in Settings.";
    case "gemini":
      return "Gemini model is missing. Select a model in Settings.";
    default:
      return `${provider.name} model is missing. Select a model in Settings.`;
  }
}

function defaultBaseUrl(providerType) {
  switch (providerType) {
    case "openai":
      return "https://api.openai.com/v1";
    case "anthropic":
      return "https://api.anthropic.com/v1";
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "ollama":
      return "http://localhost:11434";
    default:
      return undefined;
  }
}

function providerNameForType(providerType) {
  switch (providerType) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "gemini":
      return "Gemini";
    case "ollama":
      return "Ollama";
    default:
      return "AI provider";
  }
}

function isPresentConfigValue(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed !== "" && trimmed.toLowerCase() !== "null" && trimmed.toLowerCase() !== "undefined";
}

function isPresentSecret(value) {
  return isPresentConfigValue(value);
}

async function loadCore() {
  if (process.env.AGENTKITFORGE_ALLOW_DEV_OVERRIDES === "1" && process.env.AGENTKITFORGE_CORE_PATH) {
    const entry = path.join(process.env.AGENTKITFORGE_CORE_PATH, "dist", "index.js");
    return import(pathToFileURL(entry).href);
  }

  const siblingEntry = path.resolve(process.cwd(), "..", "agentkitforge-core", "dist", "index.js");
  try {
    return await import(pathToFileURL(siblingEntry).href);
  } catch {
    // Fall back to the installed package.
  }

  return import("@agentkitforge/core");
}
