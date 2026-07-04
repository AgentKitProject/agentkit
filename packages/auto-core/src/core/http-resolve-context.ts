/**
 * HTTP resolver for a run's kit context.
 *
 * The Fargate worker has no direct access to web-forge's KitStore / draft
 * resolver, so it calls web-forge's INTERNAL resolve endpoint over HTTP to fetch
 * the run's system prompt, kit context, declared tools, the per-run inference
 * mode, and (when BYO) the BYO provider config. That keeps auto-core free of any
 * hard web-forge dependency: the only coupling is this small HTTP contract.
 *
 * Security:
 *   - The response may contain a rendered system prompt / kit context and a BYO
 *     API key. NEVER log the response body. On a non-2xx we surface ONLY the HTTP
 *     status, never the body (which could echo a prompt back).
 */

import type { AiProviderType, ToolDefinition } from "@agentkitforge/gateway-core";
import type { ResolveKitContext, ResolvedKitContext } from "../entrypoints/worker.js";

/** Shape returned by web-forge's `/api/internal/auto/resolve-context` endpoint. */
export interface ResolveContextResponse {
  systemPrompt?: string;
  kitContext?: string;
  /** Tools the kit declares (Anthropic tool-definition shape). */
  tools: ToolDefinition[];
  /** Tool names the kit declares (intersected with the approval allowlist). */
  toolNames: string[];
  /** Optional model hint. */
  model?: string;
  /** Per-run billing mode resolved by web-forge. */
  inferenceMode: "managed" | "byo";
  /**
   * Present only when `inferenceMode === "byo"`: the user's own provider config.
   * Multi-provider: `providerType` selects which adapter the worker builds (one
   * of anthropic/openai/openai-compatible/gemini/ollama). A legacy payload that
   * omits it is treated as "anthropic" by the worker. `model` is an optional
   * default model for providers that take it in their constructor.
   */
  byoProvider?: { providerType?: AiProviderType; apiKey: string; baseUrl?: string; model?: string };
  /**
   * True when this is a PROTECTED (paid / online-only) Market kit (M6). The worker
   * uses it to enable output redaction bound to `systemPrompt`. Absent/false on
   * local / free / self-host runs (no redaction).
   */
  protected?: boolean;
  /**
   * PREMIUM (per-invocation) kit royalty context (M6 P5), serialized to the worker
   * so a worker-dispatched run meters the seller's per-run royalty exactly like the
   * in-process path. Present ONLY for a premium kit (perRunRoyaltyCents > 0); absent
   * on local / free / non-premium runs (the royalty path stays inert). See the
   * matching fields on ResolvedKitContext (worker.ts) for semantics. The commission
   * bps flows through from the Market service response; never hardcoded.
   */
  premiumRoyaltyCents?: number;
  royaltyOrgId?: string;
  royaltyKitId?: string;
  royaltyCommissionBps?: number;
}

export interface FetchResolveContextArgs {
  runId: string;
  /** web-forge base URL, e.g. https://forge.agentkitproject.com (no trailing slash needed). */
  baseUrl: string;
  /** Shared service key trusted by the internal endpoint. */
  serviceKey: string;
  /** Injectable fetch for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * POSTs `{ runId }` to `${baseUrl}/api/internal/auto/resolve-context`.
 *
 * Throws on non-2xx (status only — never the body) and on a malformed payload.
 */
export async function fetchResolveContext(
  args: FetchResolveContextArgs,
): Promise<ResolveContextResponse> {
  const { runId, baseUrl, serviceKey } = args;
  const fetchImpl = args.fetchImpl ?? fetch;

  const url = `${baseUrl.replace(/\/+$/, "")}/api/internal/auto/resolve-context`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${serviceKey}`,
      "x-service-key": serviceKey,
    },
    body: JSON.stringify({ runId }),
  });

  if (!response.ok) {
    // NEVER include the body — it may echo back a rendered prompt.
    throw new Error(`resolve-context failed: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== "object") {
    throw new Error("resolve-context failed: malformed response (not an object)");
  }
  const p = payload as Partial<ResolveContextResponse>;
  if (!Array.isArray(p.tools) || !Array.isArray(p.toolNames)) {
    throw new Error("resolve-context failed: malformed response (tools/toolNames not arrays)");
  }
  if (p.inferenceMode !== "managed" && p.inferenceMode !== "byo") {
    throw new Error("resolve-context failed: malformed response (missing inferenceMode)");
  }

  return p as ResolveContextResponse;
}

/**
 * Adapts an already-fetched {@link ResolveContextResponse} into a
 * {@link ResolveKitContext} hook. The hook ignores its `(run, approval)` args —
 * `processAutoRun` already enforces the approval gate and calls the hook exactly
 * once — and resolves to the kit portion of the payload. Using a pre-fetched
 * payload avoids a second HTTP round-trip.
 */
export function toResolveKitContext(payload: ResolveContextResponse): ResolveKitContext {
  return async (): Promise<ResolvedKitContext> => ({
    ...(payload.systemPrompt !== undefined ? { systemPrompt: payload.systemPrompt } : {}),
    ...(payload.kitContext !== undefined ? { kitContext: payload.kitContext } : {}),
    tools: payload.tools,
    toolNames: payload.toolNames,
    ...(payload.protected ? { protected: true } : {}),
    // PREMIUM royalty context (M6 P5): forward the same per-run royalty fields the
    // worker's run-driver deps need. Present only for a premium kit; absent
    // otherwise → the royalty path stays inert.
    ...(payload.premiumRoyaltyCents !== undefined
      ? { premiumRoyaltyCents: payload.premiumRoyaltyCents }
      : {}),
    ...(payload.royaltyOrgId !== undefined ? { royaltyOrgId: payload.royaltyOrgId } : {}),
    ...(payload.royaltyKitId !== undefined ? { royaltyKitId: payload.royaltyKitId } : {}),
    ...(payload.royaltyCommissionBps !== undefined
      ? { royaltyCommissionBps: payload.royaltyCommissionBps }
      : {}),
  });
}
