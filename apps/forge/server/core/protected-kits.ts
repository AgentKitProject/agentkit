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
  forgeMarketRoutes,
  isPremiumPriceModel,
  marketServiceRoutes,
  marketServiceAuthHeader,
  publicKitDetailResponseSchema,
  serviceEntitledKitsResponseSchema,
  type ServiceEntitledKit,
  type ServiceLicensedPackageError,
  type ServiceLicensedPackageResponse
} from "@agentkitforge/contracts";
import { loadCoreMarket } from "@/server/core/load-core";
import { unzipToTree } from "@/server/core/operations";
import { withEphemeralTree } from "@/server/core/runner";
import { getEcosystemLinks, getMarketBaseUrl, isMarketEnabled } from "@/lib/self-host";

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
  /**
   * True for a PREMIUM (per_invocation) kit — the seller earns a per-run royalty
   * that is ONLY metered on the AUTO run path (M6 P5). Such a kit must therefore
   * NEVER be run on the interactive web-Forge gateway (which does not meter the
   * royalty); the interactive create path refuses it and directs the user to Auto.
   */
  premium: boolean;
}

/**
 * Read the kit's PRICE MODEL from the PUBLIC kit-detail record (`GET
 * /api/forge/kits/{slug}` — no auth, no bytes, content-free). P3 surfaces
 * `priceModel`/`perRunRoyaltyCents` on that public record (`toPublicKit`), so this
 * is the content-free signal for whether a kit is PREMIUM (per_invocation).
 *
 * Fails CLOSED-to-NON-PREMIUM: any missing Market URL, network/parse/non-2xx
 * error, or absent field → `false`. That keeps the gate INERT for non-premium and
 * for instances without a Market — it never blocks a run on a lookup hiccup; the
 * downstream entitlement gate still protects protected non-premium kits.
 */
export async function isPremiumKit(ref: ProtectedKitRef): Promise<boolean> {
  const base = marketBaseUrl(ref.marketBaseUrl);
  if (!base) return false;
  const endpoint = `${base.replace(/\/+$/, "")}${forgeMarketRoutes.kitDetail(ref.slug)}`;
  let response: Response;
  try {
    response = await fetch(endpoint, { method: "GET", cache: "no-store" });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  const body = (await response.json().catch(() => null)) as unknown;
  const parsed = publicKitDetailResponseSchema.safeParse(body);
  if (!parsed.success) return false;
  // `publicKitDetailSchema` is passthrough, so `priceModel` rides along untyped.
  const priceModel = (parsed.data.item as { priceModel?: string }).priceModel;
  return isPremiumPriceModel(priceModel as never);
}

/**
 * Classify a kit by reading the Market catalog record (pricing + visibility) for
 * THIS user. A kit is PROTECTED when it is paid OR online-only (paid + not
 * downloadable). Free, freely-downloadable kits are NOT protected and keep the
 * existing owned/local behavior.
 *
 * Uses the entitlement-status read (no bytes fetched). `store` carries the user's
 * forwarded WorkOS bearer so the per-user `entitled` flag is accurate. A protected
 * kit is ALSO checked for the PREMIUM (per_invocation) price model via the public
 * kit-detail record — premium kits are Auto-run-only (metering leak guard, M6 #9);
 * the create path refuses them interactively. The premium lookup runs ONLY for a
 * protected kit (free kits are never premium), so it stays inert otherwise.
 */
export async function classifyKit(store: TokenStore, ref: ProtectedKitRef): Promise<KitClassification> {
  const market = await loadCoreMarket();
  const status = await market.checkEntitlement(store, {
    slug: ref.slug,
    marketBaseUrl: marketBaseUrl(ref.marketBaseUrl),
    clientId: clientId()
  });
  const isProtected = status.pricing === "paid" || status.onlineOnly === true;
  const premium = isProtected ? await isPremiumKit(ref) : false;
  return {
    isProtected,
    pricing: status.pricing,
    downloadable: status.downloadable,
    onlineOnly: status.onlineOnly,
    entitled: status.entitled === true,
    premium,
    ...(status.kitId ? { kitId: status.kitId } : {})
  };
}

/**
 * Thrown when an interactive web-Forge run is attempted for a PREMIUM
 * (per_invocation) kit. Premium kits meter the seller's per-run royalty ONLY on
 * the AUTO run path, so the INTERACTIVE gateway must refuse and redirect to Auto
 * (M6 #9). Carries NO kit content — only the public slug + the public Auto run URL
 * (omitted on self-host without a configured Auto). The route maps it to a 409
 * content-free directive.
 */
export class PremiumRunOnAutoError extends Error {
  readonly code = "run_on_auto_required" as const;
  readonly slug: string;
  readonly kitId?: string;
  /** Public AgentKitAuto run URL, if this instance exposes one (else undefined). */
  readonly autoUrl?: string;
  constructor(ref: ProtectedKitRef, kitId?: string) {
    super(
      "This is a premium (per-run) kit — run it on AgentKitAuto, where the seller's " +
        "per-run royalty is metered. Interactive runs on Forge are not available for premium kits."
    );
    this.name = "PremiumRunOnAutoError";
    this.slug = ref.slug;
    const autoUrl = getEcosystemLinks().autoUrl;
    if (kitId !== undefined) this.kitId = kitId;
    if (autoUrl) this.autoUrl = autoUrl;
  }

  /** The content-free JSON body the create routes return (HTTP 409). */
  toResponseBody(): {
    code: "run_on_auto_required";
    message: string;
    slug: string;
    kitId?: string;
    autoUrl?: string;
  } {
    return {
      code: this.code,
      message: this.message,
      slug: this.slug,
      ...(this.kitId ? { kitId: this.kitId } : {}),
      ...(this.autoUrl ? { autoUrl: this.autoUrl } : {})
    };
  }
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

/** Build the Market service entitled-kits URL. Requires a Market base URL
 *  (per-instance AGENTKITMARKET_BASE_URL; self-host without a Market fails
 *  closed → undefined). */
function serviceEntitledKitsUrl(override?: string): string | undefined {
  const base = marketBaseUrl(override);
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}${marketServiceRoutes.entitledKits()}`;
}

/**
 * List the asserted user's PROTECTED (paid + non-downloadable) entitled kits
 * SERVER-TO-SERVICE (no user session), via MARKET_SERVICE_KEY + the explicitly
 * asserted userId. The Market service enforces entitlement (only ACTIVE
 * entitlements are listed) and filters to protected kits, returning ONLY
 * browser-safe display fields (name/slug/marketKitId) — never entitlement
 * internals or kit content. Mirrors auto-web's listEntitledKitsViaService.
 *
 * Fails CLOSED:
 *   - Market disabled on this instance (self-host, no own Market) → []. The
 *     buyer-run surface is simply absent; local kits still build/run.
 *   - MARKET_SERVICE_KEY unconfigured → []. No phone-home, no list.
 *   - Any service/network/non-2xx/parse error → [] (the run discovery degrades
 *     to empty rather than failing the page). The protected-RUN path is
 *     unaffected and still entitlement-gated server-side at execution.
 */
export async function listEntitledKitsViaService(
  userId: string,
  override?: string
): Promise<ServiceEntitledKit[]> {
  // Self-host with Market disabled → no list (fail closed, never phone home).
  if (!isMarketEnabled()) return [];
  const key = marketServiceKey();
  if (!key || key.length === 0) return [];
  const url = serviceEntitledKitsUrl(override);
  if (!url) return [];

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        [marketServiceAuthHeader]: key
      },
      body: JSON.stringify({ userId }),
      cache: "no-store"
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  const payload = (await response.json().catch(() => ({}))) as { kits?: unknown };
  const parsed = serviceEntitledKitsResponseSchema.safeParse(payload);
  return parsed.success ? parsed.data.kits : [];
}

// ---------------------------------------------------------------------------
// Leakage guards (best-effort) — SHARED MECHANISM lives in @agentkitforge/auto-core
// ---------------------------------------------------------------------------
//
// `isPromptExtractionAttempt` (pre-turn refusal) and `redactLeakedPrompt` (mask
// verbatim prompt chunks out of emitted text / tool-call args) are a generic,
// value-free mechanism. They are owned by auto-core's leakage-guard module so the
// INTERACTIVE gateway path (gateway-sessions.ts) and the AUTONOMOUS Auto run path
// share ONE implementation — no duplication, no drift. This app's gateway turn
// emitter imports `redactLeakedPrompt` from here, so we re-export the shared
// helpers to keep that import site stable. (Previously forge-web carried its OWN
// byte-identical fork of these; collapsed onto the shared module in M6 Slice 4 —
// no behavioral change, the fork matched the shared impl exactly.)
export { isPromptExtractionAttempt, redactLeakedPrompt } from "@agentkitforge/auto-core";

// These constants mirror auto-core/leakage-guard.ts and back this app's redaction
// regression test (kept in sync with the shared mechanism).
const LEAK_MIN_CHARS = 80;
const LEAK_WINDOW = 120;
const REDACTION = "[redacted: protected kit content]";

export const __test = { PROTECTED_REF_PREFIX, LEAK_MIN_CHARS, LEAK_WINDOW, REDACTION };
