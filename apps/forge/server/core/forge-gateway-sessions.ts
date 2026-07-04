// Forge (bearer / non-browser) gateway streaming-session composition root.
//
// Gateway Phase 2c-i — enable desktop / CLI / Auto clients to run a LOCAL kit
// through the managed inference gateway WITH tool execution ("remote brain,
// local hands"). This is the bearer-auth sibling of server/core/gateway-sessions.ts
// (the cookie/web path) and shares the SAME runtime: DynamoSessionStore, credit
// ledger, managed Anthropic provider, and the gateway-core router + SSE adapter.
//
// HOW IT DIFFERS FROM THE WEB PATH
// --------------------------------
// 1. AUTH: callers are authenticated by lib/forge-auth.ts (WorkOS device-auth
//    bearer JWT), NOT the AuthKit cookie. `userId` is the forge user id; sessions
//    are scoped to it (CLAUDE.md hard rule #4 — the two auth paths never mix).
//
// 2. KIT CONTEXT IS CLIENT-PROVIDED. A desktop/CLI kit is LOCAL — it is NOT in
//    the web KitStore. So the CLIENT supplies the kit's assembled system context
//    at session-create (`systemPrompt`/`kitContext`), derived from the kit on the
//    client. We persist it (with the declared tools) inside the session's
//    `systemPromptRef` — which gateway-core documents as a server-side reference
//    OR raw prompt text. resolveSystemPrompt for this path returns that stored
//    text; it is placed in the ChatRequest and NEVER emitted to the client (the
//    Tier-3 invariant still holds end-to-end).
//
//    >>> TIER-3 SERVER-FETCH SEAM (Phase 3) <<<
//    For PROTECTED Market-licensed kits the server must fetch the kit content
//    server-side (from object storage, entitlement-checked) and NEVER trust the
//    client to supply it — exactly like the web path's KitStore load. That fetch
//    hangs off `resolveSystemPrompt` here (branch on session metadata / a future
//    `kitId` + entitlement) instead of returning the client text. For now we
//    default-allow owned/local/free kits and use the client-provided context.
//
// 3. TOOLS ARE DECLARED BY THE CLIENT. The desktop knows its local-hands tool
//    set (file read/write, run command, ...). It declares those at create
//    (`tools: [{ name, description, input_schema }]`); resolveTools returns them
//    so runStreamingTurn passes them to the provider. On stop_reason "tool_use"
//    the turn PAUSES and the SSE stream emits the tool_call; the client executes
//    it locally and POSTs /tool-result to resume under the same credit hold.
//    Tools are OPT-IN per session: a forge session with no declared tools is
//    conversational, exactly like the web path (which never declares tools).
import {
  createGatewaySession,
  createManagedRoutingProvider,
  routeGatewayRequest,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayRouterDeps,
  type GatewaySession,
  type SseEmitter,
  type SessionStore,
  type ToolDefinition
} from "@agentkitforge/gateway-core";
import type { StreamEvent } from "@agentkitforge/gateway-core";
import { getCreditLedger } from "@/server/core/gateway";
import { getSessionStore } from "@/server/core/gateway-sessions";
import { MANAGED_DEFAULT_MODEL } from "@/server/core/managed-models";
import {
  classifyKit,
  createBearerTokenStore,
  decodeProtectedRef,
  encodeProtectedRef,
  redactLeakedPrompt,
  resolveProtectedSystemPrompt,
  type ProtectedKitRef
} from "@/server/core/protected-kits";

/** Default output-token ceiling per provider round-trip for a chat turn. */
const TURN_MAX_TOKENS = 4096;

/** Max characters of client-provided kit context we will persist + inject. */
export const MAX_CONTEXT_CHARS = 200_000;
/** Max number of client-declared tools per session. */
export const MAX_TOOLS = 64;
/** Max characters for a single tool's serialized declaration. */
export const MAX_TOOL_CHARS = 16_000;

/**
 * What the forge client supplies at session-create, encoded into the session's
 * `systemPromptRef`. Carrying it on the session means resolveSystemPrompt /
 * resolveTools can recover it on every later /turn + /tool-result without a new
 * DynamoDB table. The sentinel prefix distinguishes a client-context ref from a
 * plain reference key (web/Tier-3 paths).
 */
interface ForgeKitContext {
  /** Assembled kit system context (client-derived for owned/local kits). */
  systemPrompt: string;
  /** Tools the client's local hands can execute. Empty ⇒ conversational. */
  tools: ToolDefinition[];
}

const CONTEXT_REF_PREFIX = "forgectx:v1:";
const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant running an Agent Kit.";

function encodeContextRef(ctx: ForgeKitContext): string {
  return CONTEXT_REF_PREFIX + JSON.stringify(ctx);
}

function decodeContextRef(ref: string): ForgeKitContext | null {
  if (!ref.startsWith(CONTEXT_REF_PREFIX)) return null;
  try {
    const parsed = JSON.parse(ref.slice(CONTEXT_REF_PREFIX.length)) as Partial<ForgeKitContext>;
    const systemPrompt = typeof parsed.systemPrompt === "string" ? parsed.systemPrompt : "";
    const tools = Array.isArray(parsed.tools) ? (parsed.tools as ToolDefinition[]) : [];
    return { systemPrompt, tools };
  } catch {
    return null;
  }
}

/** Validation error surfaced as a 400 by the create route. */
export class ForgeContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForgeContextError";
  }
}

/**
 * Validates + normalizes the client-provided kit context and tool declarations.
 * Bounds the sizes so a malicious / buggy client cannot blow up the session
 * record or the provider request. Throws ForgeContextError (→ 400) on violation.
 */
export function buildForgeContext(input: {
  systemPrompt?: unknown;
  kitContext?: unknown;
  tools?: unknown;
}): ForgeKitContext {
  // `kitContext` is an accepted alias for `systemPrompt`.
  const rawPrompt =
    typeof input.systemPrompt === "string"
      ? input.systemPrompt
      : typeof input.kitContext === "string"
        ? input.kitContext
        : "";

  if (rawPrompt.length > MAX_CONTEXT_CHARS) {
    throw new ForgeContextError(
      `Kit context exceeds the ${MAX_CONTEXT_CHARS}-character limit (got ${rawPrompt.length}).`
    );
  }
  const systemPrompt = rawPrompt.trim().length > 0 ? rawPrompt : DEFAULT_SYSTEM_PROMPT;

  const tools = normalizeTools(input.tools);
  return { systemPrompt, tools };
}

function normalizeTools(raw: unknown): ToolDefinition[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ForgeContextError('Field "tools" must be an array of tool declarations.');
  }
  if (raw.length > MAX_TOOLS) {
    throw new ForgeContextError(`Too many tools declared (max ${MAX_TOOLS}).`);
  }
  const out: ToolDefinition[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      throw new ForgeContextError("Each tool must be an object { name, description, input_schema }.");
    }
    const r = item as Record<string, unknown>;
    const name = r["name"];
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new ForgeContextError("Each tool requires a non-empty string `name`.");
    }
    if (seen.has(name)) {
      throw new ForgeContextError(`Duplicate tool name: ${name}.`);
    }
    seen.add(name);
    const description = typeof r["description"] === "string" ? r["description"] : "";
    // Accept both snake_case (Anthropic wire) and camelCase from clients.
    const schema = r["input_schema"] ?? r["inputSchema"];
    const inputSchema =
      schema && typeof schema === "object" ? (schema as Record<string, unknown>) : { type: "object" };
    const tool: ToolDefinition = { name, description, inputSchema };
    if (JSON.stringify(tool).length > MAX_TOOL_CHARS) {
      throw new ForgeContextError(`Tool "${name}" declaration is too large (max ${MAX_TOOL_CHARS} chars).`);
    }
    out.push(tool);
  }
  return out;
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
 * Resolves the injected system prompt for a forge session.
 *
 * For owned/local kits this returns the CLIENT-PROVIDED context persisted at
 * create (decoded from `systemPromptRef`). The text is placed in the ChatRequest
 * by gateway-core and never emitted to the client.
 *
 * TIER-3 SEAM: a PROTECTED Market-licensed kit must NOT trust client context —
 * branch here to fetch the kit package server-side from object storage
 * (entitlement-checked), exactly as the web path loads from the KitStore. That
 * is Phase 3; for now we default-allow and use the client context.
 */
async function resolveSystemPrompt(session: GatewaySession, bearerToken?: string): Promise<string> {
  // PROTECTED Market kit: fetch the kit content server-side from Market
  // (entitlement-gated, in-memory), NEVER trusting any client-provided context.
  const protectedRef = decodeProtectedRef(session.systemPromptRef);
  if (protectedRef) {
    if (!bearerToken) {
      // No forwarded bearer at turn time → cannot fetch the entitled package.
      throw new Error("A signed-in session is required to run this protected kit.");
    }
    const store = createBearerTokenStore(bearerToken);
    return resolveProtectedSystemPrompt(store, protectedRef);
  }
  const ctx = decodeContextRef(session.systemPromptRef);
  if (ctx) return ctx.systemPrompt;
  // Legacy / non-context ref → safe default (never leak a raw ref to the model).
  return DEFAULT_SYSTEM_PROMPT;
}

/**
 * Per-request turn context for the forge path: carries the forwarded bearer into
 * resolveSystemPrompt (for protected kits) and captures the resolved protected
 * prompt so the emitter can redact verbatim leaks. Inert for owned/local kits.
 */
function makeForgeTurnContext(bearerToken?: string) {
  let injectedPrompt: string | null = null;
  let isProtected = false;
  const resolve = async (session: GatewaySession): Promise<string> => {
    const prompt = await resolveSystemPrompt(session, bearerToken);
    if (decodeProtectedRef(session.systemPromptRef)) {
      isProtected = true;
      injectedPrompt = prompt;
    }
    return prompt;
  };
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
 * Resolves the tools declared by the client at create (decoded from the session
 * ref). Empty for conversational forge sessions. Passing tools to the provider
 * is what enables the tool-use pause/resume loop in runStreamingTurn.
 */
async function resolveTools(session: GatewaySession): Promise<ToolDefinition[]> {
  const ctx = decodeContextRef(session.systemPromptRef);
  return ctx?.tools ?? [];
}

/**
 * Builds the GatewayRouterDeps for one forge request. Reuses the shared session
 * store, credit ledger, and managed provider; wires resolveSystemPrompt +
 * resolveTools for the client-provided-context model.
 */
function buildRouterDeps(
  createEmitter: () => SseEmitter,
  model: string,
  bearerToken?: string
): GatewayRouterDeps {
  const sessions = getSessionStore();
  const ledger = getCreditLedger();
  const chatProvider = createManagedRoutingProvider();
  // Per-request turn context: threads the forwarded bearer into the protected
  // server-fetch + redacts verbatim prompt leaks from emitted events.
  const turnCtx = makeForgeTurnContext(bearerToken);
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
      now
      // Entitlement is enforced at create (createProtectedForgeSession) — the
      // router create handler is bypassed for forge, so no check is wired here.
    },
    turn: {
      chatProvider,
      sessions,
      ledger,
      resolveSystemPrompt: turnCtx.resolve,
      resolveTools,
      now,
      model,
      maxTokens: TURN_MAX_TOKENS,
      ...(markupBps() !== undefined ? { markupBps: markupBps() } : {})
    },
    createEmitter: guardedCreateEmitter
  };
}

/** Thrown by createProtectedForgeSession when the user is not entitled. The
 *  route maps it to 403 { code: "not_entitled" }. */
export class ForgeNotEntitledError extends Error {
  constructor(message = "No active entitlement for this protected kit.") {
    super(message);
    this.name = "ForgeNotEntitledError";
  }
}

/**
 * Creates a forge session for an OWNED/LOCAL kit using the CLIENT-PROVIDED
 * context (existing behavior). Bypasses the router's create handler so we can
 * capture the session id + persist the context into `systemPromptRef`.
 */
export async function createForgeSession(input: {
  userId: string;
  kitId?: string;
  kitSlug?: string;
  context: ForgeKitContext;
}): Promise<GatewaySession> {
  const sessions = getSessionStore();
  return createGatewaySession(
    { sessions, now },
    {
      userId: input.userId,
      kitId: input.kitId,
      kitSlug: input.kitSlug,
      billing: "managed",
      systemPromptRef: encodeContextRef(input.context)
    }
  );
}

/**
 * Classifies a Market kit for the forge (bearer) create path using the forwarded
 * WorkOS device-auth token. Returns whether it is PROTECTED. The route uses this
 * to choose between createForgeSession (owned/local) and createProtectedForgeSession.
 */
export async function classifyForgeKit(
  bearerToken: string,
  ref: ProtectedKitRef
): Promise<{ isProtected: boolean; entitled: boolean }> {
  const store = createBearerTokenStore(bearerToken);
  const c = await classifyKit(store, ref);
  return { isProtected: c.isProtected, entitled: c.entitled };
}

/**
 * Creates a forge session for a PROTECTED Market kit. ENTITLEMENT-GATED: verifies
 * the user holds an active entitlement (via the forwarded bearer) and rejects with
 * ForgeNotEntitledError otherwise. The session's `systemPromptRef` is the protected
 * marker (NOT client context) so every turn fetches the kit content server-side.
 * Forces billing:"managed". Any client-provided context is IGNORED.
 */
export async function createProtectedForgeSession(input: {
  userId: string;
  bearerToken: string;
  ref: ProtectedKitRef;
}): Promise<GatewaySession> {
  const store = createBearerTokenStore(input.bearerToken);
  const classification = await classifyKit(store, input.ref);
  if (!classification.entitled) {
    throw new ForgeNotEntitledError();
  }
  const sessions = getSessionStore();
  return createGatewaySession(
    { sessions, now },
    {
      userId: input.userId,
      ...(input.ref.kitId ? { kitId: input.ref.kitId } : {}),
      kitSlug: input.ref.slug,
      billing: "managed",
      systemPromptRef: encodeProtectedRef(input.ref)
    }
  );
}

/**
 * Adapts a normalized forge gateway request (turn / tool-result / delete) to
 * gateway-core's router with the forge deps. The route layer resolves `userId`
 * from the bearer token and verifies session ownership BEFORE calling this. The
 * forwarded bearer is threaded in so protected kits can be fetched server-side.
 */
export async function handleForgeGatewayRequest(
  req: GatewayRequest,
  createEmitter: () => SseEmitter,
  model: string = MANAGED_DEFAULT_MODEL,
  bearerToken?: string
): Promise<GatewayResponse> {
  return routeGatewayRequest(buildRouterDeps(createEmitter, model, bearerToken), req);
}

/**
 * Loads a session and asserts it belongs to the forge `userId`. Returns null for
 * missing OR cross-user sessions (callers treat both as 404). Sessions are
 * user-scoped; the router does not re-check ownership, so the route layer MUST
 * gate with this before /turn | /tool-result | DELETE.
 */
export async function loadOwnedForgeSession(
  userId: string,
  sessionId: string
): Promise<GatewaySession | null> {
  const session = await getSessionStore().getSession(sessionId);
  if (!session || session.userId !== userId) return null;
  return session;
}

export type { ForgeKitContext };
export { decodeContextRef as __decodeContextRefForTest, encodeContextRef as __encodeContextRefForTest };
