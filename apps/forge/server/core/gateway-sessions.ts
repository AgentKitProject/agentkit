// Gateway streaming-session composition root for Web Forge (Gateway Phase 2b).
//
// This is the wiring that turns @agentkitforge/gateway-core's transport-agnostic
// router (POST /gateway/sessions, /turn, /tool-result, DELETE) into something
// this app can run against its own runtime:
//
//   - SessionStore     — DynamoSessionStore over GATEWAY_SESSIONS_TABLE, using
//                        the SAME region/credentials as the KitStore + credit
//                        ledger (awsClientEnv() / FORGE_AWS_*).
//   - ChatProvider     — the managed Anthropic provider (platform ANTHROPIC_API_KEY),
//                        reused from server/core/gateway.ts's pattern. Inert when
//                        ANTHROPIC_API_KEY is unset (provider factory throws; the
//                        turn surfaces a clear error event — BYO is unaffected).
//   - CreditLedger     — reused from getCreditLedger() so holds/settles bill the
//                        SAME prepaid-credit balance the rest of the app uses.
//   - resolveSystemPrompt — loads the kit's tree from the caller's KitStore by the
//                        session's kitId and builds the kit system prompt SERVER-
//                        SIDE via @agentkitforge/core's buildAgentKitContext. The
//                        prompt is injected into the ChatRequest and NEVER emitted
//                        to the client (Tier-3 invariant enforced by core).
//
// Sessions are scoped to the authenticated user: createGatewaySession stores
// `userId` on the session; the route adapter (app/api/gateway/*) verifies the
// session's userId matches the caller before /turn, /tool-result, or DELETE.
//
// CONVERSATIONAL-ONLY this pass: no tools are resolved (resolveTools omitted →
// defaults to none), so the model never emits tool_use in normal operation.
// Local-hands tool execution (desktop 2c) + a future restricted browser tool
// executor will inject `resolveTools` + drive the tool-result round-trips.
import {
  DynamoSessionStore,
  createDynamoDBDocumentClient,
  createManagedRoutingProvider,
  loadDynamoTableNames,
  routeGatewayRequest,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayRouterDeps,
  type GatewaySession,
  type SseEmitter,
  type SessionStore
} from "@agentkitforge/gateway-core";
import type { EntitlementCheck, StreamEvent } from "@agentkitforge/gateway-core";
import { awsClientEnv } from "@/server/aws-client";
import { getCreditLedger } from "@/server/core/gateway";
import { getKitStore } from "@/server/store/index";
import { withEphemeralTree } from "@/server/core/runner";
import { MANAGED_DEFAULT_MODEL } from "@/server/core/managed-models";
import {
  classifyKit,
  decodeProtectedRef,
  encodeProtectedRef,
  marketEntitlementCheck,
  redactLeakedPrompt,
  resolveProtectedSystemPrompt,
  type ProtectedKitRef
} from "@/server/core/protected-kits";

/** Default output-token ceiling per provider round-trip for a chat turn. */
const TURN_MAX_TOKENS = 4096;

let sessionStoreSingleton: SessionStore | null = null;

/**
 * The shared DynamoDB session store. Built lazily so deployments that never run
 * managed inference don't require GATEWAY_SESSIONS_TABLE. Throws if the env var
 * is missing (fail-fast misconfig) — same contract as getCreditLedger().
 */
export function getSessionStore(): SessionStore {
  if (!sessionStoreSingleton) {
    const tables = loadDynamoTableNames(process.env);
    const env = awsClientEnv();
    const db = createDynamoDBDocumentClient({
      region: env.region,
      ...(env.credentials ? { credentials: env.credentials } : {})
    });
    sessionStoreSingleton = new DynamoSessionStore(db, tables.sessions);
  }
  return sessionStoreSingleton;
}

/** ISO-8601 clock injected into the session + streaming-turn services. */
function now(): string {
  return new Date().toISOString();
}

function markupBps(): number | undefined {
  const raw = process.env.GATEWAY_MARKUP_BPS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolves the kit's injected system prompt SERVER-SIDE for a session.
 *
 * Loads the session owner's kit tree from the KitStore (by kitId), materializes
 * it into an ephemeral temp dir, and runs @agentkitforge/core's
 * buildAgentKitContext to assemble AGENTKIT.md / START_HERE.md / skills +
 * instructions into a single `systemContext` string. This text is placed in the
 * ChatRequest by gateway-core and is NEVER emitted to the client.
 *
 * The kit is loaded under the session's `userId` so a buyer can only run kits
 * they own in their own store (Tier-3 entitlement for Market-licensed kits is a
 * later phase — default allow for owned/free kits this pass).
 */
/**
 * Lazily loads the cookie-session forwarding store. DYNAMIC import so this
 * (cookie/AuthKit-coupled) module is NEVER pulled into the FORGE bearer route's
 * import graph (CLAUDE.md hard rule #4) — the forge path imports getSessionStore
 * from this file but must not transitively load AuthKit.
 */
async function forwardingStore() {
  const { createForwardingStore } = await import("@/server/core/import-ops");
  return createForwardingStore();
}

async function resolveSystemPrompt(session: GatewaySession): Promise<string> {
  // PROTECTED Market kit: the session's systemPromptRef tags it as Tier-3. Fetch
  // the kit content server-side from Market (entitlement-gated, in-memory) — NEVER
  // from the KitStore and NEVER from client context.
  const protectedRef = decodeProtectedRef(session.systemPromptRef);
  if (protectedRef) {
    const store = await forwardingStore();
    return resolveProtectedSystemPrompt(store, protectedRef);
  }
  if (!session.kitId) {
    // Raw / promptless session — no kit content to inject.
    return "You are a helpful assistant running an Agent Kit.";
  }
  const store = await getKitStore();
  const tree = await store.getKitTree(session.userId, session.kitId);
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
  return trimmed.length > 0
    ? trimmed
    : "You are a helpful assistant running an Agent Kit.";
}

/**
 * Wraps `resolveSystemPrompt` so the resolved prompt for a protected session is
 * captured (in a closure cell) and used by the leakage-redaction emitter. For
 * non-protected sessions the cell stays null and no redaction is applied.
 */
function makeProtectedTurnContext() {
  let injectedPrompt: string | null = null;
  let isProtected = false;
  const resolve = async (session: GatewaySession): Promise<string> => {
    const prompt = await resolveSystemPrompt(session);
    if (decodeProtectedRef(session.systemPromptRef)) {
      isProtected = true;
      injectedPrompt = prompt;
    }
    return prompt;
  };
  /** Redacts long verbatim chunks of the injected prompt from emitted text /
   *  tool-call args (best-effort leakage guard). No-op for non-protected turns. */
  const guardEvent = (event: StreamEvent): StreamEvent => {
    if (!isProtected || !injectedPrompt) return event;
    if (event.type === "text") {
      return { ...event, delta: redactLeakedPrompt(event.delta, injectedPrompt) };
    }
    if (event.type === "tool_use" && typeof event.inputPartial === "string") {
      return { ...event, inputPartial: redactLeakedPrompt(event.inputPartial, injectedPrompt) };
    }
    return event;
  };
  return { resolve, guardEvent };
}

/**
 * Builds the GatewayRouterDeps for one request. `createEmitter` is supplied by
 * the route adapter (it knows how to write SSE chunks to its ReadableStream).
 *
 * @param model  The managed model id selected by the caller (validated by the
 *               route); falls back to MANAGED_DEFAULT_MODEL.
 */
/** Per-create options. Carries an optional Market entitlement gate, supplied by
 *  the route only for a PROTECTED kit. */
export interface GatewayCreateOpts {
  entitlementCheck?: EntitlementCheck;
}

function buildRouterDeps(
  createEmitter: () => SseEmitter,
  model: string,
  opts?: GatewayCreateOpts
): GatewayRouterDeps {
  const sessions = getSessionStore();
  const ledger = getCreditLedger();
  // The managed provider routes by model to the PLATFORM ANTHROPIC_API_KEY
  // (claude-*) or OPENAI_API_KEY (gpt-*). Each family's factory throws inertly
  // when its key is unset — only when a turn selects it — and runStreamingTurn
  // surfaces that as an `error` event.
  const chatProvider = createManagedRoutingProvider();
  // Per-request turn context: captures the protected prompt during resolve and
  // redacts verbatim leaks from emitted events. Inert for non-protected turns.
  const turnCtx = makeProtectedTurnContext();
  const guardedCreateEmitter = (): SseEmitter => {
    const inner = createEmitter();
    return {
      emit: (event) => inner.emit(turnCtx.guardEvent(event)),
      close: () => inner.close()
    };
  };
  return {
    session: {
      sessions,
      now,
      // Tier-3: a Market entitlement check is injected ONLY for protected kits at
      // create time. Omitted for owned/free kits → default allow.
      ...(opts?.entitlementCheck ? { entitlementCheck: opts.entitlementCheck } : {})
    },
    turn: {
      chatProvider,
      sessions,
      ledger,
      resolveSystemPrompt: turnCtx.resolve,
      // resolveTools omitted → no tools this pass (conversational-only).
      now,
      model,
      maxTokens: TURN_MAX_TOKENS,
      ...(markupBps() !== undefined ? { markupBps: markupBps() } : {})
    },
    createEmitter: guardedCreateEmitter
  };
}

/**
 * Adapts a normalized gateway request to gateway-core's router with this app's
 * deps. The route layer resolves `userId` from the AuthKit session and verifies
 * session ownership BEFORE calling this for /turn, /tool-result, and DELETE.
 *
 * `opts.entitlementCheck` is supplied ONLY by the create path for a PROTECTED
 * Market kit (the route classifies the kit first). All other requests / kinds
 * leave it unset → default allow.
 */
export async function handleGatewayRequest(
  req: GatewayRequest,
  createEmitter: () => SseEmitter,
  model: string = MANAGED_DEFAULT_MODEL,
  opts?: GatewayCreateOpts
): Promise<GatewayResponse> {
  return routeGatewayRequest(buildRouterDeps(createEmitter, model, opts), req);
}

/**
 * Classifies a kit for the web (cookie) create path and returns what the route
 * needs to build the create request:
 *   - PREMIUM (per_invocation): returns `premium: true` — the route MUST refuse
 *     the interactive run and direct the user to Auto (premium royalty is metered
 *     ONLY on the Auto run path; interactive Forge would leak it). M6 #9.
 *   - PROTECTED (paid / online-only, non-premium): returns a `protected:`
 *     systemPromptRef + an entitlement check to inject (→ 403 not_entitled when not
 *     entitled), and forces managed billing. Any client-provided context is IGNORED.
 *   - OWNED/free: returns nothing extra → existing KitStore behavior.
 *
 * `slug` is required to talk to Market; the web route passes kitId+slug from the
 * catalog selection.
 */
export async function classifyWebKit(ref: ProtectedKitRef): Promise<{
  isProtected: boolean;
  premium: boolean;
  kitId?: string;
  systemPromptRef?: string;
  entitlementCheck?: EntitlementCheck;
}> {
  const store = await forwardingStore();
  const classification = await classifyKit(store, ref);
  if (!classification.isProtected) return { isProtected: false, premium: false };
  if (classification.premium) {
    // Premium kits are AUTO-RUN-ONLY (metering leak guard). Do NOT wire the
    // interactive session; the route refuses with the run-on-Auto directive.
    return {
      isProtected: true,
      premium: true,
      ...(classification.kitId ? { kitId: classification.kitId } : {})
    };
  }
  return {
    isProtected: true,
    premium: false,
    ...(classification.kitId ? { kitId: classification.kitId } : {}),
    systemPromptRef: encodeProtectedRef(ref),
    entitlementCheck: marketEntitlementCheck(() => forwardingStore(), ref)
  };
}

/**
 * Loads a session and asserts it belongs to `userId`. Returns the session, or
 * null if it does not exist OR belongs to another user (callers treat both as
 * 404 so cross-user probing can't distinguish them). Sessions are user-scoped:
 * the router itself does not re-check ownership on /turn|/tool-result|DELETE, so
 * the route layer MUST gate with this before forwarding those requests.
 */
export async function loadOwnedSession(
  userId: string,
  sessionId: string
): Promise<GatewaySession | null> {
  const session = await getSessionStore().getSession(sessionId);
  if (!session || session.userId !== userId) return null;
  return session;
}
