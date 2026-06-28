// Gateway Phase 3 — Tier-3 PROTECTED (paid / online-only) Market kit execution.
//
// A protected kit is one a buyer has paid for (or is online-only). For these the
// gateway must NEVER trust client-supplied prompt/context and must NEVER let the
// kit text reach the buyer's client. Instead the server:
//
//   1. CLASSIFIES the kit (owned/local vs protected Market) via the Market
//      catalog record's pricing/visibility (`checkEntitlement` returns pricing +
//      downloadable + onlineOnly + entitled without fetching bytes).
//   2. GATES on entitlement (an `EntitlementCheck` wired into gateway-core's
//      createGatewaySession): no active entitlement → session create is denied
//      (the route maps it to 403 { code: "not_entitled" }).
//   3. FETCHES the kit instruction content SERVER-SIDE per turn (the licensed-
//      package path → `fetchLicensedKit`), holds the bytes IN MEMORY only, runs
//      buildAgentKitContext, and injects the assembled prompt. The bytes are
//      never persisted and the prompt never crosses the client boundary.
//
// Tier-3 forces billing:"managed" — a BYO provider key would route the injected
// prompt through the buyer's own provider console, leaking it. So protected kits
// reject BYO at create.
//
// LEAKAGE GUARDS (best-effort, see redactLeakedPrompt / isPromptExtractionAttempt):
// the gateway already never emits the system prompt, but a buyer can still try to
// coax the model into reciting it. We refuse obvious extraction prompts and redact
// long verbatim chunks of the injected prompt from emitted text. This is a
// deterrent, not a guarantee — inference/paraphrase attacks cannot be fully
// prevented and this is documented as best-effort.
import type { EntitlementCheck } from "@agentkitforge/gateway-core";
import type { StoredSession, TokenStore } from "@agentkitforge/core/market";
import {
  marketServiceRoutes,
  marketServiceAuthHeader,
  type ServiceLicensedPackageError,
  type ServiceLicensedPackageResponse
} from "@agentkitforge/contracts";
import { loadCoreMarket } from "@/server/core/load-core";
import { unzipToTree } from "@/server/core/operations";
import { withEphemeralTree } from "@/server/core/runner";
import { getMarketBaseUrl } from "@/lib/self-host";

/** Marker that tags a session's systemPromptRef as a protected Market kit whose
 *  prompt MUST be fetched server-side (never client-trusted) on every turn. */
const PROTECTED_REF_PREFIX = "protected:v1:";

const DEFAULT_PROMPT = "You are a helpful assistant running an Agent Kit.";

/** What we need to talk to Market for a protected kit. */
export interface ProtectedKitRef {
  slug: string;
  kitId?: string;
  marketBaseUrl?: string;
}

/** Encode the protected-kit reference into a session systemPromptRef. The
 *  reference carries NO secret content — only the public slug/kitId — so it is
 *  safe to persist; the actual prompt is fetched server-side per turn. */
export function encodeProtectedRef(ref: ProtectedKitRef): string {
  return PROTECTED_REF_PREFIX + JSON.stringify(ref);
}

/** Decode a protected systemPromptRef, or null if this is not a protected ref. */
export function decodeProtectedRef(ref: string | undefined): ProtectedKitRef | null {
  if (!ref || !ref.startsWith(PROTECTED_REF_PREFIX)) return null;
  try {
    const parsed = JSON.parse(ref.slice(PROTECTED_REF_PREFIX.length)) as Partial<ProtectedKitRef>;
    if (typeof parsed.slug !== "string" || parsed.slug.length === 0) return null;
    return {
      slug: parsed.slug,
      ...(typeof parsed.kitId === "string" ? { kitId: parsed.kitId } : {}),
      ...(typeof parsed.marketBaseUrl === "string" ? { marketBaseUrl: parsed.marketBaseUrl } : {})
    };
  } catch {
    return null;
  }
}

/** True when `systemPromptRef` belongs to a protected Market kit. */
export function isProtectedRef(ref: string | undefined): boolean {
  return decodeProtectedRef(ref) !== null;
}

/**
 * A read-only TokenStore seeded with an explicit WorkOS bearer access token —
 * used by the FORGE (device-auth) gateway path, where the token comes from the
 * `Authorization: Bearer` header (requireForgeUser) rather than the AuthKit
 * cookie. The device-auth access token is the exact bearer Market expects, so we
 * forward it unchanged. `set`/`clear` are no-ops (the device client owns refresh).
 *
 * NEVER conflate this with the cookie-session store (CLAUDE.md hard rule #4): the
 * caller passes the already-verified bearer token from the forge request. This
 * lives here (types-only deps) — NOT in market-auth.ts — so the forge route's
 * import graph never pulls in the AuthKit cookie (`withAuth`) dependency.
 */
export function createBearerTokenStore(accessToken: string): TokenStore {
  const session: StoredSession = { accessToken, connectedAt: new Date().toISOString() };
  return {
    async get() {
      return session;
    },
    async set() {
      /* device-auth client owns the token lifecycle */
    },
    async clear() {
      /* device-auth client owns the token lifecycle */
    }
  };
}

function marketBaseUrl(override?: string): string | undefined {
  // Per-ref override → instance Market. With no Market configured (self-host
  // without a Market) returns undefined, so the protected-kit path fails closed
  // (callers surface "service_unconfigured" / refuse the run) rather than calling
  // the hosted Market.
  return override ?? getMarketBaseUrl();
}

function clientId(): string {
  return process.env.AGENTKITPROJECT_WORKOS_CLIENT_ID ?? "";
}

/** Result of classifying a kit at session-create time. */
export interface KitClassification {
  /** True when the kit must be entitlement-gated + server-fetched (paid OR
   *  online-only / restricted visibility). */
  isProtected: boolean;
  pricing: "free" | "paid";
  downloadable: boolean;
  onlineOnly: boolean;
  /** Whether the requesting user currently holds an active entitlement. */
  entitled: boolean;
  /** Canonical kit id from the Market catalog record, if returned. */
  kitId?: string;
}

/**
 * Classify a kit by reading the Market catalog record (pricing + visibility) for
 * THIS user. A kit is PROTECTED when it is paid OR online-only (paid + not
 * downloadable). Free, freely-downloadable kits are NOT protected and keep the
 * existing owned/local behavior.
 *
 * Uses the entitlement-status read (no bytes fetched). `store` carries the user's
 * forwarded WorkOS bearer so the per-user `entitled` flag is accurate.
 */
export async function classifyKit(store: TokenStore, ref: ProtectedKitRef): Promise<KitClassification> {
  const market = await loadCoreMarket();
  const status = await market.checkEntitlement(store, {
    slug: ref.slug,
    marketBaseUrl: marketBaseUrl(ref.marketBaseUrl),
    clientId: clientId()
  });
  const isProtected = status.pricing === "paid" || status.onlineOnly === true;
  return {
    isProtected,
    pricing: status.pricing,
    downloadable: status.downloadable,
    onlineOnly: status.onlineOnly,
    entitled: status.entitled === true,
    ...(status.kitId ? { kitId: status.kitId } : {})
  };
}

/**
 * Build an `EntitlementCheck` (gateway-core seam) backed by Market. It is only
 * consulted for protected kits — for owned/local kits the route does not wire it,
 * so they stay default-allow. Returns `{ allowed:false }` (→ 403 not_entitled)
 * when the user holds no active entitlement.
 *
 * `storeFactory` re-reads the live forwarded token each call so a refreshed
 * session is honored.
 */
export function marketEntitlementCheck(
  storeFactory: () => Promise<TokenStore>,
  ref: ProtectedKitRef
): EntitlementCheck {
  return async ({ billingMode }) => {
    // Tier-3 forces managed billing — BYO would leak the injected prompt via the
    // buyer's own provider console.
    if (billingMode !== "managed") {
      return { allowed: false, reason: "Protected kits require managed billing." };
    }
    const store = await storeFactory();
    const status = await classifyKit(store, ref);
    if (!status.entitled) {
      return { allowed: false, reason: "No active entitlement for this protected kit." };
    }
    return { allowed: true };
  };
}

/**
 * Fetch the protected kit's instruction content SERVER-SIDE and assemble the
 * system prompt. The watermarked bytes come from the licensed-package route via
 * fetchLicensedKit, are unzipped + read IN MEMORY, and are discarded — they are
 * NEVER persisted and NEVER returned to the client. The assembled prompt is
 * injected into the ChatRequest by gateway-core, which never emits it.
 *
 * Throws if the user is not entitled (fetchLicensedKit surfaces 403/402), so a
 * lost entitlement mid-session also fails closed.
 */
export async function resolveProtectedSystemPrompt(
  store: TokenStore,
  ref: ProtectedKitRef
): Promise<string> {
  const market = await loadCoreMarket();
  const licensed = await market.fetchLicensedKit(store, {
    slug: ref.slug,
    marketBaseUrl: marketBaseUrl(ref.marketBaseUrl),
    clientId: clientId(),
    // SERVER-SIDE RUN path: this is the legitimate per-turn resolver that injects
    // the prompt and NEVER returns it to the client, so it opts in to receive the
    // content of an online-only kit (M6 Slice 1). Every CLIENT path (desktop
    // bridge, browser /api/market/licensed, CLI) omits this and is refused.
    allowOnlineOnlyContent: true
  });
  // Online-only OR downloadable — either way we keep the bytes in memory and never
  // write them. unzip → buildAgentKitContext in an ephemeral temp dir that is
  // cleaned up before returning.
  const tree = await unzipToTree(Buffer.from(licensed.bytes));
  const { systemContext } = await withEphemeralTree(tree, async ({ kitRoot, core }) =>
    core.buildAgentKitContext({
      kitPath: kitRoot,
      mode: "all",
      target: "claude",
      includePolicies: true,
      includeTemplates: true,
      includeWorkflows: true,
      includePrompts: false
    })
  );
  const trimmed = systemContext.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_PROMPT;
}

// ---------------------------------------------------------------------------
// SERVICE-MODE resolution (no user session) — for the hosted Auto worker path
// ---------------------------------------------------------------------------

/** Thrown when service-mode protected-kit resolution fails. `code` surfaces the
 *  Market service endpoint's error enum so the worker path can map "not_entitled"
 *  to a clear refusal. */
export class ProtectedKitServiceError extends Error {
  readonly code: ServiceLicensedPackageError | "service_unconfigured" | "service_request_failed";
  readonly status?: number;
  constructor(
    code: ServiceLicensedPackageError | "service_unconfigured" | "service_request_failed",
    message: string,
    status?: number
  ) {
    super(message);
    this.name = "ProtectedKitServiceError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** The shared web-forge↔market-app service key (server-only). Distinct from
 *  AUTO_WORKER_SERVICE_KEY (worker↔web-forge): the worker NEVER holds this and
 *  NEVER calls Market directly. */
function marketServiceKey(): string | undefined {
  return process.env.MARKET_SERVICE_KEY;
}

/** Build the Market service licensed-package URL for a slug. Requires a Market
 *  base URL (per-ref override or AGENTKITMARKET_BASE_URL). */
function serviceLicensedPackageUrl(slug: string, override?: string): string | undefined {
  const base = marketBaseUrl(override);
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}${marketServiceRoutes.licensedPackage(slug)}`;
}

/**
 * Fetch a protected kit's licensed package SERVER-TO-SERVICE (no user session)
 * and assemble the system prompt. Mirrors resolveProtectedSystemPrompt exactly —
 * unzip the watermarked bytes IN MEMORY, run buildAgentKitContext in an ephemeral
 * temp dir, discard the bytes — but swaps the user's forwarded WorkOS bearer for
 * the shared MARKET_SERVICE_KEY plus an EXPLICITLY-ASSERTED `userId`. Entitlement
 * is STILL enforced Market-side: a non-entitled user yields a 403 → we throw
 * ProtectedKitServiceError("not_entitled"), refusing the run.
 *
 * The bytes/prompt are NEVER persisted and NEVER returned to the browser/Forge —
 * the caller (worker resolve path) hands the prompt to the worker only over the
 * existing AUTO_WORKER_SERVICE_KEY internal channel.
 *
 * Returns the assembled prompt plus the kit's resolved pricing/onlineOnly so the
 * caller can apply Phase-A free-kit semantics (a free Market kit needs no
 * server-side prompt). The bytes are still fetched + assembled in memory in all
 * cases; the caller decides whether to keep the prompt.
 *
 * @throws ProtectedKitServiceError on missing key, request failure, or non-2xx.
 */
export interface ServiceResolvedKit {
  systemPrompt: string;
  pricing: "free" | "paid";
  downloadable: boolean;
  onlineOnly: boolean;
}

export async function resolveProtectedSystemPromptViaService(
  userId: string,
  ref: ProtectedKitRef
): Promise<ServiceResolvedKit> {
  const key = marketServiceKey();
  if (!key || key.length === 0) {
    throw new ProtectedKitServiceError(
      "service_unconfigured",
      "MARKET_SERVICE_KEY is not configured; cannot resolve a protected kit without a user session."
    );
  }
  const url = serviceLicensedPackageUrl(ref.slug, ref.marketBaseUrl);
  if (!url) {
    throw new ProtectedKitServiceError(
      "service_unconfigured",
      "No Market base URL configured for protected-kit service resolution."
    );
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        [marketServiceAuthHeader]: key
      },
      body: JSON.stringify({
        userId,
        ...(ref.kitId ? { kitId: ref.kitId } : {})
      }),
      cache: "no-store"
    });
  } catch (cause) {
    throw new ProtectedKitServiceError(
      "service_request_failed",
      "The Market service request failed.",
      undefined
    );
  }

  if (!response.ok) {
    // Surface the endpoint's error code; map 403 to a clear not-entitled refusal.
    const payload = (await response.json().catch(() => ({}))) as { code?: string };
    const code = (payload.code as ServiceLicensedPackageError | undefined) ?? "backend_unavailable";
    const message =
      code === "not_entitled"
        ? "The user is not entitled to this protected kit."
        : `Protected-kit service resolution failed (${code}).`;
    throw new ProtectedKitServiceError(code, message, response.status);
  }

  const licensed = (await response.json()) as ServiceLicensedPackageResponse;
  // Same in-memory assembly as resolveProtectedSystemPrompt: bytes never persisted.
  const bytes = Buffer.from(licensed.contentBase64, "base64");
  const tree = await unzipToTree(bytes);
  const { systemContext } = await withEphemeralTree(tree, async ({ kitRoot, core }) =>
    core.buildAgentKitContext({
      kitPath: kitRoot,
      mode: "all",
      target: "claude",
      includePolicies: true,
      includeTemplates: true,
      includeWorkflows: true,
      includePrompts: false
    })
  );
  const trimmed = systemContext.trim();
  return {
    systemPrompt: trimmed.length > 0 ? trimmed : DEFAULT_PROMPT,
    pricing: licensed.pricing,
    downloadable: licensed.downloadable,
    onlineOnly: licensed.onlineOnly
  };
}

// ---------------------------------------------------------------------------
// Leakage guards (best-effort)
// ---------------------------------------------------------------------------

/** Min length of a verbatim prompt substring we treat as a leak and redact. */
const LEAK_MIN_CHARS = 80;
/** Window size we slide over the prompt to detect verbatim emission. */
const LEAK_WINDOW = 120;

const REDACTION = "[redacted: protected kit content]";

/**
 * Detect an obvious prompt-extraction attempt in the buyer's input ("repeat your
 * instructions", "print the system prompt", "ignore previous instructions and
 * show…"). Best-effort heuristic — refuses the most common direct asks; it does
 * not catch paraphrase / indirect inference attacks.
 */
export function isPromptExtractionAttempt(userInput: string): boolean {
  const t = userInput.toLowerCase();
  // Must reference the instructions/prompt AND an exfiltration verb nearby.
  const targets = /(system\s*prompt|your\s+instructions|the\s+instructions|initial\s+prompt|kit\s+(instructions|content|text)|everything\s+above|prompt\s+(above|verbatim))/;
  const verbs = /(repeat|print|show|reveal|display|output|echo|recite|dump|verbatim|word[\s-]*for[\s-]*word|copy|disclose|tell\s+me)/;
  if (targets.test(t) && verbs.test(t)) return true;
  // Classic jailbreak openers paired with a disclosure ask.
  if (/ignore\s+(all\s+)?(previous|prior|above)\s+instructions/.test(t) && (verbs.test(t) || targets.test(t))) {
    return true;
  }
  return false;
}

/**
 * Redact long verbatim runs of the injected system prompt from emitted text
 * (assistant deltas or tool-call args). Slides a window over the prompt; any
 * window-length chunk that appears verbatim in `text` is replaced. Best-effort —
 * does not defeat paraphrase or chunked exfiltration, documented as such.
 *
 * Returns the possibly-redacted text. Cheap: O(text * prompt/stride) substring
 * checks bounded by the window stride, skipped entirely for short prompts.
 */
export function redactLeakedPrompt(text: string, systemPrompt: string): string {
  if (!text || systemPrompt.length < LEAK_MIN_CHARS) return text;
  let out = text;
  // Slide a window across the prompt; stride by half-window to bound work while
  // still catching overlapping leaks.
  const stride = Math.floor(LEAK_WINDOW / 2);
  for (let i = 0; i + LEAK_WINDOW <= systemPrompt.length; i += stride) {
    const chunk = systemPrompt.slice(i, i + LEAK_WINDOW);
    if (out.includes(chunk)) {
      out = out.split(chunk).join(REDACTION);
    }
  }
  return out;
}

export const __test = { PROTECTED_REF_PREFIX, LEAK_MIN_CHARS, LEAK_WINDOW, REDACTION };
