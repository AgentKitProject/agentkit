// AgentKitAuto composition root for Web Forge — Phase A.
//
// Wires the NEW @agentkitforge/auto-core package (hosted, on-demand,
// run-to-completion autonomous Agent Kit runs) into this app's runtime,
// mirroring the gateway composition roots (server/core/gateway.ts,
// gateway-sessions.ts, forge-gateway-sessions.ts):
//
//   - STORAGE      — makeAutoDeps({ backend }) keyed off KITSTORE_BACKEND, using
//                    the SAME FORGE_AWS_* region/credentials as the KitStore +
//                    credit ledger, and the new AUTO_RUNS_TABLE/AUTO_APPROVALS_TABLE
//                    DynamoDB tables (defaults AutoRuns/AutoApprovals).
//   - BILLING      — the PLATFORM Anthropic provider + the gateway credit ledger,
//                    reused verbatim from the gateway (createManagedAnthropicProvider
//                    + getCreditLedger()). Auto NEVER invents billing — every model
//                    turn runs through gateway-core's managed-turn pricing.
//   - KIT CONTEXT  — resolveKitContext resolves a kit (KitStore id OR Market ref) to
//                    { systemPrompt, tools, model } SERVER-SIDE, reusing the
//                    gateway's resolution + classifyKit / protected-kit path. For a
//                    protected/paid kit the prompt is fetched server-side and is
//                    NEVER returned to the browser.
//   - DISPATCH     — an injectable dispatcher. Phase A ships an IN-PROCESS async
//                    dispatcher (processAutoRun invoked fire-and-forget after the
//                    route responds). This is DEV / SELF-HOST ONLY — see the big
//                    note on inProcessDispatcher below. Hosted long-running
//                    execution requires the DEFERRED Fargate / k8s-Job worker
//                    (Amplify SSR functions cannot host a long autonomous run).
//
// AUTH NOTE: this module is auth-agnostic. The cookie route (/api/auto/*) and the
// bearer route (/api/forge/auto/*) each resolve `userId` with their OWN auth
// helper and call the SAME functions here. The two auth paths never mix (CLAUDE.md
// hard rule #4); they only converge on this shared, userId-keyed core logic.

import {
  ApprovalDeniedError,
  confineInputPath,
  consumeWebhook,
  CronParseError,
  generateWebhookSecret,
  hashWebhookSecret,
  inputObjectKey,
  HttpLedgerClient,
  loadAutoV2Rates,
  makeAutoDeps,
  makeFreeCreditLedger,
  nextFireAfter,
  normalizeNetworkPolicy,
  processAutoRun,
  runDueSchedules,
  validateCron,
  validateDeliveryConfig,
  WebhookError,
  type AutoApproval,
  type AutoBackend,
  type AutoRun,
  type AutoV2Rates,
  type AutoRunInputFileRef,
  type AutoSchedule,
  type AutoStorageDeps,
  type AutoWebhook,
  type CreateApprovalInput,
  type CreateRunInput,
  type CreateScheduleInput,
  type CreateWebhookInput,
  type DeliveryConfig,
  type KitRef,
  type NetworkPolicy,
  type ProcessAutoRunDeps,
  type ResolveKitContext,
  type ResolvedKitContext,
  type ScheduleSweepSummary,
  type UpdateScheduleInput
} from "@agentkitforge/auto-core";
import {
  buildChatProvider,
  createManagedAnthropicProvider,
  type AiProviderType,
  type ChatProvider,
  type CreditLedgerRepository,
  type ToolDefinition
} from "@agentkitforge/gateway-core";
import { randomUUID } from "node:crypto";
import { autoHookRoutes } from "@agentkitforge/contracts";
import { awsClientEnv } from "@/server/aws-client";
import { getAppUrl } from "@/lib/url-config";
import { fargateDispatcher } from "@/server/core/auto-fargate-dispatcher";
import { kubeJobDispatcher } from "@/server/core/auto-kube-dispatcher";
import { getCreditLedger } from "@/server/core/gateway";
import { creditLedgerBackend, isSelfHost, isSelfHostManagedBilling } from "@/lib/self-host";
import { getUserSettingsStore } from "@/server/store/user-settings";
import { resolveOrgApiKey } from "@/server/core/org-key-client";
import { checkOrgUsage, recordOrgUsage as recordOrgUsageSeam } from "@/server/core/org-usage-client";
import { getKitStore } from "@/server/store/index";
import { withEphemeralTree } from "@/server/core/runner";
import { MANAGED_DEFAULT_MODEL, isManagedModel } from "@/server/core/managed-models";
import {
  classifyKit,
  resolveProtectedSystemPrompt,
  resolveProtectedSystemPromptViaService,
  isPromptExtractionAttempt,
  ProtectedKitServiceError,
  type ProtectedKitRef
} from "@/server/core/protected-kits";
import type { StoredSession, TokenStore } from "@agentkitforge/core/market";

export { ApprovalDeniedError };
export type { AutoApproval, AutoRun, AutoRunInputFileRef, AutoSchedule, AutoWebhook, DeliveryConfig, KitRef, NetworkPolicy };

// ---------------------------------------------------------------------------
// Storage deps (singleton)
// ---------------------------------------------------------------------------

let storageSingleton: AutoStorageDeps | null = null;

/** Maps KITSTORE_BACKEND → an auto-core storage backend. local → "aws" deps are
 *  not built; instead local/dev uses the aws adapter pointed at whatever DynamoDB
 *  the FORGE_AWS_* creds resolve (local DynamoDB or a real table). selfhost →
 *  Postgres. We follow the KitStore's backend selector so Auto storage always
 *  lives next to the rest of the app's persistence. */
function autoBackend(): AutoBackend {
  const raw = (process.env.KITSTORE_BACKEND || "local").toLowerCase();
  // selfhost → Postgres adapter; aws + local(dev) → DynamoDB adapter.
  return raw === "selfhost" ? "selfhost" : "aws";
}

function autoTableNames(): { runs: string; approvals: string; schedules: string; webhooks: string } {
  return {
    runs: process.env.AUTO_RUNS_TABLE || "AutoRuns",
    approvals: process.env.AUTO_APPROVALS_TABLE || "AutoApprovals",
    // Phase B: the standing-schedules table (auto-core's aws adapter requires it
    // via loadAutoDynamoTableNames; we always pass an explicit name so deployments
    // that haven't set the env still get the documented default).
    schedules: process.env.AUTO_SCHEDULES_TABLE || "AutoSchedules",
    // Phase C: the standing-webhooks table (auto-core's aws adapter requires all
    // four names; we always pass an explicit default like the others).
    webhooks: process.env.AUTO_WEBHOOKS_TABLE || "AutoWebhooks"
  };
}

/** The S3 bucket backing Phase C staged input files (`auto-inputs/{runId}/...`).
 *  Reuses the kit-trees bucket via AUTO_INPUTS_BUCKET (defaulting to the KitStore
 *  S3_BUCKET when unset). When unset entirely, auto-core's aws adapter falls back
 *  to a LocalInputStore (fine for dev/tests). */
function autoInputsBucket(): string | undefined {
  return process.env.AUTO_INPUTS_BUCKET || process.env.S3_BUCKET || undefined;
}

/**
 * The shared auto-core storage deps (runs + approvals repos + ephemeral
 * workspace). Built lazily so deployments that never use Auto don't require the
 * tables. For the aws backend it composes against the SAME region/credentials as
 * the KitStore + credit ledger (awsClientEnv / FORGE_AWS_*).
 */
export async function getAutoStorage(): Promise<AutoStorageDeps> {
  if (storageSingleton) return storageSingleton;
  const backend = autoBackend();
  if (backend === "selfhost") {
    // Reuse the KitStore's Postgres pool so Auto rows live in the same database.
    const { getSelfHostPgPool } = await import("@/server/store/selfhost-user-settings");
    const pool = await getSelfHostPgPool();
    // Ensure the four Auto tables exist (idempotent CREATE TABLE IF NOT EXISTS).
    // The app creates them next to the rest of its self-host schema; the k8s
    // worker also ensures them on boot, so either side bootstrapping is safe.
    const { ensureAutoSchema } = await import("@agentkitforge/auto-core");
    await ensureAutoSchema(pool as never);
    storageSingleton = makeAutoDeps({ backend: "selfhost", pool });
  } else {
    const env = awsClientEnv();
    const { createDynamoDBDocumentClient } = await import("@agentkitforge/auto-core");
    const db = createDynamoDBDocumentClient({
      region: env.region,
      ...(env.credentials ? { credentials: env.credentials } : {})
    });
    const inputsBucket = autoInputsBucket();
    storageSingleton = makeAutoDeps({
      backend: "aws",
      db,
      tables: autoTableNames(),
      // Phase C: when set, staged run-input files are read from S3 (auto-inputs/
      // prefix) during hydration; otherwise auto-core uses a LocalInputStore.
      ...(inputsBucket ? { inputsBucket } : {})
    });
  }
  return storageSingleton;
}

/** ISO-8601 clock. */
function now(): string {
  return new Date().toISOString();
}

/**
 * The UTC calendar-month key ("YYYY-MM") for an ISO timestamp — the bucket the
 * ledger keys a user's monthly FREE active-minute allowance by. MUST match
 * auto-core's run-driver `utcYearMonth` (UTC, same format) so the pre-flight's
 * free-minute read and the driver's depletion address the SAME month row.
 */
function utcYearMonth(iso: string): string {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function markupBps(): number | undefined {
  const raw = process.env.GATEWAY_MARKUP_BPS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The Auto MANAGED markup, in basis points. Separate from the interactive
 * gateway's GATEWAY_MARKUP_BPS — Auto managed inference is marked up at
 * AUTO_MARKUP_BPS (default 0 = tokens at cost; set server-side). Server-chosen;
 * never client-supplied.
 */
export function autoMarkupBps(): number {
  const raw = process.env.AUTO_MARKUP_BPS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

/**
 * Resolves the Auto v2 run-fee rates (flat invocation fee + per-active-minute
 * rate + monthly free-minute allowance) for THIS deployment, in US cents.
 *
 * The rates are gated on `creditLedgerBackend()`: a "free" backend (open-core /
 * self-host default) yields 0/0/0 so a self-host pays nothing and the v2-fee
 * path is never entered — matching run-task's `managed` gate. A metered backend
 * ("dynamo" / "postgres", i.e. hosted or self-host-managed billing) resolves the
 * commercial moat rates via auto-core's shared `loadAutoV2Rates` (the SAME
 * resolver the worker uses, so app + worker bill identically). Env overrides
 * (AUTO_INVOCATION_FEE_CENTS / AUTO_ACTIVE_MINUTE_RATE_CENTS /
 * AUTO_FREE_ACTIVE_MINUTES_PER_MONTH) are honored by the resolver.
 *
 * Cached per process: the rates are deployment constants (commercial pricing +
 * env), so we resolve them once and reuse — the in-process dispatcher and the
 * pre-flight check share the same numbers.
 */
let v2RatesPromise: Promise<AutoV2Rates> | null = null;
export function autoV2Rates(): Promise<AutoV2Rates> {
  if (!v2RatesPromise) {
    const enabled = creditLedgerBackend() !== "free";
    v2RatesPromise = loadAutoV2Rates(enabled);
  }
  return v2RatesPromise;
}

/** Test/ops seam: drop the cached v2 rates so a test that mutates the env (or the
 *  ledger backend) re-resolves them. */
export function resetAutoV2RatesCache(): void {
  v2RatesPromise = null;
}

/**
 * The MINIMUM credit cost (US cents) a run must be able to afford up front,
 * given the resolved v2 rates and the user's REMAINING free active-minutes this
 * month. This is the pre-flight gate: every metered run pays at least the flat
 * invocation fee plus — when no free active-minutes remain — one active-minute.
 *
 *   estimate = invocationFeeCents
 *            + (freeMinutesRemaining > 0 ? 0 : activeMinuteRateCents)
 *
 * The first active-minute is FREE when the user still has free allowance, so we
 * only require balance for the active-minute when the allowance is exhausted.
 * The invocation fee is never free-tiered, so it always counts. With both rates
 * 0 (self-host FREE) the estimate is 0 → no balance is required.
 */
export function estimateMinRunCostCents(rates: AutoV2Rates, freeMinutesRemaining: number): number {
  const invocation = Math.max(0, rates.invocationFeeCents);
  const activeMinute = Math.max(0, rates.activeMinuteRateCents);
  const firstMinuteCost = freeMinutesRemaining > 0 ? 0 : activeMinute;
  return invocation + firstMinuteCost;
}

/** A user's Auto v2 billing snapshot for the UI (balance + free-minute state). */
export interface AutoBillingSummary {
  /** True when this deployment meters runs (hosted / managed). False on a FREE
   *  self-host — then balance/free-minutes are not surfaced (runs are unmetered). */
  metered: boolean;
  /** Available prepaid credit balance, in US cents. */
  balanceCents: number;
  /** Free active-minutes the user has REMAINING this UTC month. */
  freeMinutesRemaining: number;
  /** The monthly free active-minute allowance (e.g. 60). */
  freeMinutesPerMonth: number;
  /** The flat per-run invocation fee, in US cents (for the UI to explain cost). */
  invocationFeeCents: number;
  /** The per-active-minute rate, in US cents. */
  activeMinuteRateCents: number;
}

/**
 * Reads a user's Auto v2 billing snapshot: prepaid balance + remaining free
 * active-minutes this month, plus the rates (so the UI can explain a run's cost
 * and link to buy credits). Read-only EXCEPT it ensureAccount's so a BYO user
 * who never topped up still resolves a 0 balance (and gets an account row ready
 * for their first run's charge). On a FREE backend (self-host) returns
 * `metered: false` with zeros — the UI then hides the credits affordance since
 * runs are unmetered.
 *
 * `ledgerOverride` is a test/ops seam: when supplied it is used instead of the
 * backend-selected ledger (the routes never pass it). The pre-flight check in
 * `startRun` runs the SAME ensureAccount + free-minute read against the
 * production ledger, so this function's metered branch exercises that logic.
 */
export async function getBillingSummary(
  userId: string,
  ledgerOverride?: CreditLedgerRepository
): Promise<AutoBillingSummary> {
  const rates = await autoV2Rates();
  const metered = rates.invocationFeeCents > 0 || rates.activeMinuteRateCents > 0;
  if (!metered) {
    return {
      metered: false,
      balanceCents: 0,
      freeMinutesRemaining: 0,
      freeMinutesPerMonth: rates.freeActiveMinutesPerMonth,
      invocationFeeCents: rates.invocationFeeCents,
      activeMinuteRateCents: rates.activeMinuteRateCents
    };
  }
  const ledger = ledgerOverride ?? (await selectLedger());
  // BYO account auto-creation: a BYO user has no account row until first run; make
  // one so the balance read is well-defined and the future charge has a target.
  await ledger.ensureAccount(userId, now());
  const account = await ledger.getAccount(userId);
  const balanceCents = account?.availableBalanceCents ?? 0;
  const freeUsed = await ledger.getFreeMinutesUsed(userId, utcYearMonth(now()));
  const freeMinutesRemaining = Math.max(0, rates.freeActiveMinutesPerMonth - freeUsed);
  return {
    metered: true,
    balanceCents,
    freeMinutesRemaining,
    freeMinutesPerMonth: rates.freeActiveMinutesPerMonth,
    invocationFeeCents: rates.invocationFeeCents,
    activeMinuteRateCents: rates.activeMinuteRateCents
  };
}

// ---------------------------------------------------------------------------
// Kit-context resolution (server-side — reuses the gateway's resolution)
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant running an Agent Kit.";

/** A read-only TokenStore seeded with a WorkOS bearer (forge path) — mirrors
 *  protected-kits.createBearerTokenStore, re-declared here so the cookie path can
 *  also pass a forwarded token when it has one. */
function bearerTokenStore(accessToken: string): TokenStore {
  const session: StoredSession = { accessToken, connectedAt: new Date().toISOString() };
  return {
    async get() {
      return session;
    },
    async set() {
      /* device-auth / forwarding client owns the lifecycle */
    },
    async clear() {
      /* no-op */
    }
  };
}

/** Lazily loads the cookie-session forwarding store (DYNAMIC import so the
 *  AuthKit-coupled module is never pulled into the forge bearer route's import
 *  graph — same discipline as gateway-sessions.ts). */
async function forwardingStore(): Promise<TokenStore> {
  const { createForwardingStore } = await import("@/server/core/import-ops");
  return createForwardingStore();
}

/** How a run's kit context is sourced for Auto — supplied per request by the
 *  route so the cookie path can use the cookie forwarding store and the forge
 *  path can use its already-verified bearer (never mixing the two). */
export interface KitContextOptions {
  /** A forwarded WorkOS bearer (forge path). When absent the cookie forwarding
   *  store is used for protected/Market lookups. */
  bearerToken?: string;
  /**
   * SERVICE MODE (hosted worker path, NO user session). When set, protected
   * Market kits are resolved server-to-service against the Market service
   * licensed-package endpoint using MARKET_SERVICE_KEY + this asserted userId,
   * instead of the user's live session. Entitlement is STILL enforced Market-side
   * (a non-entitled user is refused). Mutually exclusive with the interactive
   * (bearer / cookie) paths — never set alongside a real user session. */
  serviceUserId?: string;
}

/**
 * Builds the ResolveKitContext hook auto-core's worker calls once per run. It
 * resolves the kit referenced by the run SERVER-SIDE:
 *
 *   - source "local": load the kit tree from the KitStore (scoped to the run's
 *     userId) and assemble the system prompt via core's buildAgentKitContext —
 *     EXACTLY like the gateway's resolveSystemPrompt.
 *   - source "market": classify the kit; if PROTECTED (paid / online-only) fetch
 *     the kit content server-side (entitlement-gated, in-memory) via
 *     resolveProtectedSystemPrompt — the prompt is NEVER returned to the client.
 *     A free Market kit falls back to the default prompt (Phase A does not yet
 *     download free Market kits into the workspace executor — that is fine: the
 *     allowlisted file tools operate on the per-run workspace, not the kit).
 *
 * Tools: the kit's declared tools are intersected by auto-core against the
 * approval allowlist AND the Phase-A sandbox tool set (read_file/list_dir/
 * write_file). We surface the approval's allowlist as the kit tool declarations
 * so the executor has tool schemas to hand the model; auto-core hard-rejects
 * run_command and any non-sandbox tool regardless of what we pass.
 */
export function makeResolveKitContext(opts: KitContextOptions): ResolveKitContext {
  return async (run: AutoRun, approval: AutoApproval): Promise<ResolvedKitContext> => {
    const toolNames = approval.toolAllowlist;
    const tools: ToolDefinition[] = toolNames.map((name) => ({
      name,
      description: "",
      inputSchema: { type: "object" }
    }));

    const ref = run.kitRef;
    if (ref.source === "market") {
      const protectedRef: ProtectedKitRef = {
        slug: ref.slug ?? "",
        ...(ref.marketKitId ? { kitId: ref.marketKitId } : {})
      };
      // Without a slug we can't talk to Market — default-prompt fall back.
      if (!protectedRef.slug) {
        return { systemPrompt: DEFAULT_SYSTEM_PROMPT, tools, toolNames };
      }

      // SERVICE MODE (hosted worker, no user session): resolve protected kits
      // server-to-service with MARKET_SERVICE_KEY + the asserted userId. Market
      // enforces entitlement (a non-entitled user is refused). A free Market kit
      // keeps the Phase-A default-prompt behavior.
      if (opts.serviceUserId) {
        const resolved = await resolveProtectedSystemPromptViaService(opts.serviceUserId, protectedRef);
        const isProtected = resolved.pricing === "paid" || resolved.onlineOnly === true;
        return {
          systemPrompt: isProtected ? resolved.systemPrompt : DEFAULT_SYSTEM_PROMPT,
          tools,
          toolNames,
          // M6: flag protected kits so the worker redacts the run output / files.
          ...(isProtected ? { protected: true } : {})
        };
      }

      const store = opts.bearerToken ? bearerTokenStore(opts.bearerToken) : await forwardingStore();
      const classification = await classifyKit(store, protectedRef);
      if (classification.isProtected) {
        // Server-side fetch; the prompt is held in memory and never returned to
        // the browser (the run record stores no prompt — only the kitRef).
        const systemPrompt = await resolveProtectedSystemPrompt(store, protectedRef);
        // M6: protected → worker redacts any verbatim leak of this prompt out of
        // the run output / workspace files before they reach the buyer.
        return { systemPrompt, tools, toolNames, protected: true };
      }
      // Free Market kit — default prompt for Phase A.
      return { systemPrompt: DEFAULT_SYSTEM_PROMPT, tools, toolNames };
    }

    // Local kit: load from the KitStore (scoped to the run owner).
    const localKitId = ref.localKitId;
    if (!localKitId) {
      return { systemPrompt: DEFAULT_SYSTEM_PROMPT, tools, toolNames };
    }
    const kitStore = await getKitStore();
    const tree = await kitStore.getKitTree(run.userId, localKitId);
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
      systemPrompt: trimmed.length > 0 ? trimmed : DEFAULT_SYSTEM_PROMPT,
      tools,
      toolNames
    };
  };
}

// ---------------------------------------------------------------------------
// Billing-mode resolution (server-chosen; never client-supplied)
// ---------------------------------------------------------------------------

/** The per-run billing facts the run-create + worker paths need. */
export interface AutoBilling {
  /** "byo" → user's own key (no inference debit); "managed" → platform key +
   * the configured markup (0 by default). */
  inferenceMode: "managed" | "byo";
  /** Built only in BYO mode (user's Anthropic key); else undefined. */
  byoChatProvider?: ChatProvider;
  /**
   * True when the active dispatcher runs on OUR hosted compute (Fargate / k8s).
   * Persisted on the run record (`is_cloud_run`) for provenance. Auto v2 no
   * longer keys the compute fee off this — the v2 invocation + active-minute fee
   * applies to EVERY metered run (managed AND BYO) regardless of where it runs.
   */
  isCloudRun: boolean;
}

/**
 * Decides the billing mode for a run BEFORE it is created/dispatched.
 *
 * inferenceMode is "byo" ONLY when the user has a configured BYO provider AND
 * the kit is NOT protected/paid. PROTECTED/paid kits FORCE "managed" — a
 * protected kit must NEVER run on a BYO key (its prompt is fetched server-side
 * and never exposed; BYO is coerced to managed here, not rejected, so the run
 * can still proceed under prepaid credits).
 *
 * Multi-provider: BYO Auto uses the user's SELECTED provider of ANY supported
 * type (anthropic/openai/openai-compatible/gemini/ollama) from their
 * UserSettingsStore. gateway-core's `buildChatProvider` maps the stored
 * (providerType, apiKey, baseUrl, model) to the right adapter, so the run loop is
 * provider-agnostic. When the user has no provider configured, behavior is
 * unchanged (org key for the operator-default provider, else operator/platform).
 *
 * @param isCloudRun whether the active dispatcher runs on our hosted compute.
 */
export async function resolveAutoBilling(args: {
  userId: string;
  kitRef: KitRef;
  isCloudRun: boolean;
  kitContext: KitContextOptions;
  /** Per-run inference-mode override. When omitted, the user's account
   *  preference ("auto" | "managed" | "byo") applies; "auto"/unset = use the BYO
   *  key when one is configured, else managed (the historical behavior). */
  inferenceModeOverride?: "managed" | "byo";
}): Promise<AutoBilling> {
  const managed = (): AutoBilling => ({
    inferenceMode: "managed",
    isCloudRun: args.isCloudRun
  });

  const byo = (provider?: ChatProvider): AutoBilling => ({
    inferenceMode: "byo",
    ...(provider ? { byoChatProvider: provider } : {}),
    isCloudRun: args.isCloudRun
  });

  // PROTECTED/paid kit → FORCE managed (never run a protected kit on a BYO key).
  // On self-host this is moot: a protected Market kit can't be entitlement-checked
  // when Market is off, so context resolution refuses the run authoritatively
  // (MarketDisabledError) before billing matters — keep the managed coercion for
  // the hosted path's prepaid-credit fallback.
  if (await isProtectedKit(args.kitRef, args.kitContext)) {
    return managed();
  }

  // Effective inference-mode choice: a per-run override wins, else the user's
  // account preference. "managed" forces the platform credit path even when a BYO
  // key exists; "byo"/"auto" fall through to BYO-key resolution below.
  const { getInferenceModePreference } = await import("@/server/core/auto-byo");
  const effectiveMode =
    args.inferenceModeOverride ?? (await getInferenceModePreference(args.userId));
  if (effectiveMode === "managed") {
    return managed();
  }

  // Resolve the user's SELECTED provider (any type) — their defaultProviderId, or
  // the sole provider. Multi-provider: buildChatProvider maps the stored type to
  // the right adapter, so a user's OpenAI/Gemini/Ollama/openai-compatible key runs
  // the same as Anthropic.
  const stored = await (await getUserSettingsStore()).resolveProvider(args.userId);
  if (stored && stored.apiKey) {
    return byo(
      buildChatProvider({
        providerType: stored.providerType,
        apiKey: stored.apiKey,
        ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
        ...(stored.defaultModel ? { model: stored.defaultModel } : {})
      })
    );
  }

  // ORG SHARED KEY: when the user has no key of their own, fall back to their team
  // org's shared key BEFORE the operator/platform key. The org holds one key per
  // provider type, so we resolve it FOR THE EFFECTIVE PROVIDER TYPE: the user's
  // selected provider's type when they have one configured (even without a key),
  // else the operator-default provider type (anthropic). This only ever runs in
  // the BYO/fallback path — a managed run returned above, so a protected/paid
  // (managed-forced) run never reaches here. Fails open: undefined → operator
  // fallback below.
  const orgProviderType: AiProviderType = stored?.providerType ?? "anthropic";
  const org = await resolveOrgApiKey(args.userId, orgProviderType);
  if (org) {
    return byo(
      buildChatProvider({
        providerType: org.providerType,
        apiKey: org.apiKey,
        ...(org.baseUrl ? { baseUrl: org.baseUrl } : {})
      })
    );
  }

  // SELF-HOST (free billing, default): there is NO managed prepaid-credit path —
  // every run is BYO. When the user hasn't configured a per-user key, fall back to
  // the operator's ANTHROPIC_API_KEY (the BYO key for a self-host instance). Mode
  // is "byo" so the free credit ledger is never touched; auto-core builds the
  // managed provider from the same ANTHROPIC_API_KEY when no byoChatProvider is
  // supplied, so we can leave it unset and still run on the operator key.
  if (isSelfHost() && !isSelfHostManagedBilling()) {
    return byo();
  }

  return managed();
}

/** True when the kit is a protected/paid (or online-only) Market kit. Local
 *  kits and free Market kits are never protected.
 *
 *  In SERVICE MODE (worker, no session) protectedness is resolved via the Market
 *  service endpoint (MARKET_SERVICE_KEY) — entitlement is enforced there. We
 *  treat a refusal/error as "protected" so billing fails CLOSED to managed (a
 *  protected kit must never run on a BYO key); the context-resolution path then
 *  surfaces the not_entitled refusal authoritatively. */
async function isProtectedKit(kitRef: KitRef, opts: KitContextOptions): Promise<boolean> {
  if (kitRef.source !== "market" || !kitRef.slug) return false;
  const protectedRef: ProtectedKitRef = {
    slug: kitRef.slug,
    ...(kitRef.marketKitId ? { kitId: kitRef.marketKitId } : {})
  };
  if (opts.serviceUserId) {
    try {
      const resolved = await resolveProtectedSystemPromptViaService(opts.serviceUserId, protectedRef);
      return resolved.pricing === "paid" || resolved.onlineOnly === true;
    } catch {
      // Fail closed: treat an unresolved Market kit as protected so billing stays
      // managed; the authoritative refusal comes from context resolution.
      return true;
    }
  }
  const store = opts.bearerToken ? bearerTokenStore(opts.bearerToken) : await forwardingStore();
  try {
    const classification = await classifyKit(store, protectedRef);
    return classification.isProtected;
  } catch {
    // Fail closed: an unresolvable Market kit (incl. Market disabled on
    // self-host) is treated as protected so it never runs on a BYO key; the
    // authoritative refusal then comes from context resolution.
    return true;
  }
}

// ---------------------------------------------------------------------------
// Managed-run kit-package STAGING (writer) — the counterpart to gateway-core's
// S3KitPackageStore reader.
//
// A MANAGED run's kit context is resolved SERVER-SIDE by the gateway/worker
// reader (gateway-core makeObjectStorageKitResolvers + S3KitPackageStore), which
// reads a kit package staged in object storage at the session's
// `systemPromptRef`. Nothing wrote that package — so here we STAGE it before
// dispatch: serialize the run's kit into the EXACT layout the reader expects
// (AGENTKIT.md / START_HERE.md / skills/*/SKILL.md + tools.json), upload it to
// `auto-kits/{runId}/package.json`, and return that key as the systemPromptRef.
//
// SCOPE: managed runs only. A BYO run resolves its kit differently (the worker's
// own resolve path / user key) and is NEVER staged — `stageManagedKitPackage`
// returns undefined for BYO. When no S3 bucket is configured (dev / in-process),
// staging is a graceful no-op (returns undefined): the in-process dispatcher
// resolves the prompt directly via makeResolveKitContext and needs no staged
// package.
// ---------------------------------------------------------------------------

/** The S3 object key a run's staged kit package lives at. Mirrors the
 *  per-run input prefix convention (`auto-inputs/{runId}/...`). */
export function kitPackageObjectKey(runId: string): string {
  return `auto-kits/${runId}/package.json`;
}

/**
 * Build the kit-package file tree to stage for a run, in the gateway-core reader's
 * layout. A LOCAL kit's stored KitTree already uses the spec file paths
 * (AGENTKIT.md, START_HERE.md, skills/<name>/SKILL.md), so we map it 1:1 and
 * append `tools.json` derived from the approval's tool allowlist (the same tool
 * set makeResolveKitContext surfaces). Returns undefined when there is no local
 * kit content to stage (a Market kit: its protected prompt is resolved server-side
 * by the worker, never staged here; a free Market kit has no local package).
 */
async function buildKitPackageTree(
  run: AutoRun,
  approval: AutoApproval,
): Promise<{ files: { path: string; content: string; encoding?: "utf8" | "base64" }[] } | undefined> {
  const ref = run.kitRef;
  if (ref.source !== "local") {
    // Market kits are resolved server-to-service by the worker (protected) or fall
    // back to the default prompt (free); there is no local package to stage.
    return undefined;
  }
  const localKitId = ref.localKitId;
  if (!localKitId) return undefined;

  const kitStore = await getKitStore();
  const tree = await kitStore.getKitTree(run.userId, localKitId);
  const files = (tree.files ?? []).map((f) => ({
    path: f.path,
    content: f.content,
    ...(f.encoding ? { encoding: f.encoding } : {}),
  }));
  if (files.length === 0) return undefined;

  // tools.json: the approval's allowlist, in the ToolDefinition shape the reader
  // (gateway-core extractTools) parses. Matches makeResolveKitContext's tool set.
  const tools: ToolDefinition[] = approval.toolAllowlist.map((name) => ({
    name,
    description: "",
    inputSchema: { type: "object" },
  }));
  // Don't clobber a kit-authored tools.json if one already exists in the tree.
  if (tools.length > 0 && !files.some((f) => f.path === "tools.json")) {
    files.push({ path: "tools.json", content: JSON.stringify(tools) });
  }
  return { files };
}

/**
 * STAGE a managed run's kit package to object storage and return the
 * `systemPromptRef` (the object key) the gateway/worker reader will read it from.
 *
 *   - BYO run            → undefined (never staged).
 *   - No S3 bucket       → undefined (dev / in-process; reader path not used).
 *   - No package to stage (Market / empty) → undefined (worker resolves it).
 *   - Otherwise          → uploads the package via gateway-core's S3KitPackageWriter
 *                          (the counterpart to the S3KitPackageStore reader) and
 *                          returns `auto-kits/{runId}/package.json`.
 *
 * Idempotent: a re-dispatched run re-stages the same key with byte-identical
 * content (PUT overwrite). The S3 client + writer are lazy-imported so a build
 * that never stages (in-process dev) never pulls @aws-sdk/client-s3.
 */
export async function stageManagedKitPackage(
  run: AutoRun,
  approval: AutoApproval,
  billing: AutoBilling,
): Promise<string | undefined> {
  if (billing.inferenceMode !== "managed") return undefined;
  const bucket = autoInputsBucket();
  if (!bucket) return undefined;

  const tree = await buildKitPackageTree(run, approval);
  if (!tree) return undefined;

  const { S3Client } = await import("@aws-sdk/client-s3");
  const { S3KitPackageWriter } = await import(
    "@agentkitforge/gateway-core/adapters/aws/s3-kit-package-store"
  );
  const env = awsClientEnv();
  const client = new S3Client({
    region: env.region,
    ...(env.credentials ? { credentials: env.credentials } : {}),
  });
  const key = kitPackageObjectKey(run.id);
  const writer = new S3KitPackageWriter({ client, bucket });
  await writer.putKitPackage(key, tree);
  return key;
}

// ---------------------------------------------------------------------------
// processAutoRun deps (billing reuse)
// ---------------------------------------------------------------------------

/**
 * Select the credit ledger for the IN-PROCESS dispatcher path.
 *
 * Chosen by STORAGE BACKEND + BILLING MODE (`creditLedgerBackend`), DECOUPLED
 * from the self-host flag — so the SAME selection serves self-host and hosted:
 *
 *   "dynamo"   (managed billing on the AWS backend): the platform DynamoDB
 *              credit ledger (getCreditLedger) — managed inference + BYO
 *              cloud-run fees debit it. This is the hosted-on-Dynamo path,
 *              unchanged.
 *   "postgres" (managed billing on the Postgres backend, KITSTORE_BACKEND=
 *              selfhost): the gateway-core PostgresCreditLedgerRepository over
 *              the SAME pool getAutoStorage() uses. This covers BOTH self-host
 *              managed billing AND the NEW hosted-on-Postgres (DOKS) managed
 *              path (SELF_HOST=false + AUTO_SELFHOST_BILLING=managed). Mirrors
 *              auto-core's worker `buildBackendDeps` exactly.
 *   "free"     (free/BYO billing — self-host default): the inert FREE ledger
 *              (auto-core's makeFreeCreditLedger). The free ledger throws on any
 *              spend path, so a misconfigured managed run fails loudly instead of
 *              granting unmetered inference.
 *
 * NOTE: long hosted runs execute on the Fargate/k8s worker (run-task.ts), which
 * builds its OWN ledger from the same signals; this in-process selection serves
 * dev + self-host Deployment runs and keeps the two paths consistent.
 */
async function selectLedger() {
  const backend = creditLedgerBackend();
  if (backend === "free") return makeFreeCreditLedger();
  if (backend === "dynamo") return getCreditLedger();

  // "postgres" (self-host managed OR hosted-on-Postgres/DOKS managed): debit the
  // credit ledger OVER HTTP through the GATEWAY SERVICE — the same
  // service-key-gated `/gateway/ledger/*` seam the worker uses. This keeps the
  // open-core auto-web image free of `@agentkit-commercial/gateway`: the gateway
  // is the only holder of its DB credentials and the only place the commercial
  // ledger runs. The web pre-flight balance read (getAccount / getFreeMinutesUsed)
  // flows through this client. Configured by GATEWAY_INTERNAL_BASE_URL +
  // GATEWAY_SERVICE_KEY (replacing the old GATEWAY_DATABASE_URL / direct
  // PostgresCreditLedgerRepository import). Absent → the inert FREE ledger (never
  // debits), so a misconfigured managed deploy fails loudly on a spend path
  // rather than granting unmetered inference.
  const gatewayBaseUrl = process.env.GATEWAY_INTERNAL_BASE_URL;
  const gatewayServiceKey = process.env.GATEWAY_SERVICE_KEY;
  if (
    gatewayBaseUrl &&
    gatewayBaseUrl.trim() !== "" &&
    gatewayServiceKey &&
    gatewayServiceKey.trim() !== ""
  ) {
    return new HttpLedgerClient({
      baseUrl: gatewayBaseUrl.trim(),
      serviceKey: gatewayServiceKey.trim(),
    }) as unknown as ReturnType<typeof makeFreeCreditLedger>;
  }
  return makeFreeCreditLedger();
}

async function buildProcessDeps(
  storage: AutoStorageDeps,
  opts: KitContextOptions,
  billing: AutoBilling
): Promise<ProcessAutoRunDeps> {
  const rates = await autoV2Rates();
  return {
    storage,
    // PLATFORM Anthropic key — same managed provider the gateway uses. On
    // self-host this reads the operator's own ANTHROPIC_API_KEY (BYO). Inert
    // (throws) when ANTHROPIC_API_KEY is unset; a run then fails with a clear
    // error rather than billing the user.
    chatProvider: createManagedAnthropicProvider(),
    // BYO provider (user's own key) when this run is BYO; auto-core uses it
    // instead of the managed provider and does NOT debit inference.
    ...(billing.byoChatProvider ? { byoChatProvider: billing.byoChatProvider } : {}),
    inferenceMode: billing.inferenceMode,
    // Backend-keyed credit ledger: Dynamo (hosted-on-AWS), Postgres (self-host
    // OR hosted-on-Postgres managed billing), or the inert free ledger
    // (free/BYO — never debited).
    ledger: await selectLedger(),
    resolveKitContext: makeResolveKitContext(opts),
    now,
    // Auto v2 token markup. When the v2 run fee is active (metered backend),
    // tokens pass through AT COST (markup 0) — the platform margin is the
    // invocation + active-minute fee threaded below. The legacy token markup
    // (AUTO_MARKUP_BPS, 0 by default) is honored only on a FREE backend / when an
    // operator wants a token margin (env override inside autoMarkupBps). Mirrors run-task's v2
    // default (markup 0) so the in-process dispatcher bills like the worker.
    markupBps: rates.invocationFeeCents > 0 || rates.activeMinuteRateCents > 0 ? 0 : autoMarkupBps(),
    // Auto v2 run fee (invocation + active-minute + monthly free allowance), in
    // US cents. Resolved from the commercial seam and gated on the ledger backend
    // (free → 0/0/0, no fee). Applies to EVERY metered run (managed AND BYO):
    // BYO inference stays unbilled (the user pays their provider) but BYO DOES
    // incur the v2 run fee. The driver skips the entire fee path when all rates
    // are 0, so a self-host pays nothing.
    invocationFeeCents: rates.invocationFeeCents,
    activeMinuteRateCents: rates.activeMinuteRateCents,
    freeActiveMinutesPerMonth: rates.freeActiveMinutesPerMonth,
    // GOVERNANCE ACCOUNTING (org budgets v2): on finalize the run-driver rolls the
    // run's final spend + active-minutes up to the user's org via the Profile usage
    // seam. Best-effort + fail-open inside the client (no-op when Profile is
    // disabled/unreachable or the user has no single org with monthly limits).
    recordOrgUsage: (info) =>
      recordOrgUsageSeam(info.userId, info.period, info.cents, info.minutes)
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Dispatches a queued run for execution. Injectable so the hosted Fargate/k8s
 *  worker (deferred) can replace the in-process dev path without touching the
 *  routes. Carries the resolved billing (mode + BYO provider) so the worker
 *  bills correctly without re-resolving. */
export type AutoDispatcher = (
  runId: string,
  opts: KitContextOptions,
  billing: AutoBilling
) => Promise<void>;

/**
 * Whether the ACTIVE dispatcher runs the job on OUR hosted compute (Fargate /
 * hosted worker). The in-process dev/self-host dispatcher runs on the caller's
 * own machine, so it is NOT a cloud run — hence false. The deferred Fargate
 * dispatcher would set this true (so BYO runs incur the per-minute compute fee).
 */
let dispatcherIsCloudRun = false;

/** True if the active dispatcher executes on our hosted compute. */
export function isCloudRunDispatcher(): boolean {
  return dispatcherIsCloudRun;
}

/**
 * IN-PROCESS dispatcher — DEV / SELF-HOST ONLY.
 *
 * Invokes processAutoRun fire-and-forget AFTER the route has responded. This is
 * suitable for `next dev`, a self-hosted long-lived Node server (k8s Deployment),
 * and tests. It is NOT suitable for hosted Amplify SSR: an SSR/Lambda function is
 * killed shortly after the response is returned, so a long autonomous run started
 * in-process would be terminated mid-flight. Hosted long-running execution
 * requires the DEFERRED Fargate task / k8s Job worker (a separate ops slice),
 * which calls the SAME @agentkitforge/auto-core `processAutoRun(runId, deps)`
 * entrypoint with these exact deps. Do NOT rely on this path for hosted runs.
 */
export const inProcessDispatcher: AutoDispatcher = async (runId, opts, billing) => {
  const storage = await getAutoStorage();
  const deps = await buildProcessDeps(storage, opts, billing);
  // Fire-and-forget: kick off the run and return immediately. Errors are already
  // recorded onto the run record by the worker (status "failed"); we swallow here
  // so an unhandled rejection can't crash the process.
  void processAutoRun(runId, deps).catch(() => {
    /* failure is persisted on the run record by processAutoRun */
  });
};

/** The active dispatcher. Defaults to in-process (dev/self-host); the hosted
 *  worker slice would swap this for a queue-enqueue implementation. */
let dispatcher: AutoDispatcher = inProcessDispatcher;

/** Test/ops seam: override the dispatcher (e.g. to assert dispatch in a test or
 *  to plug in the Fargate enqueue). `isCloudRun` declares whether the new
 *  dispatcher runs on our hosted compute (drives the BYO per-minute fee). */
export function setAutoDispatcher(next: AutoDispatcher, isCloudRun = false): void {
  dispatcher = next;
  dispatcherIsCloudRun = isCloudRun;
}

/**
 * One-time dispatcher selection at module import.
 *
 *   - HOSTED: AUTO_DISPATCH=fargate AND an AWS KitStore backend → the Fargate
 *     worker (isCloudRun=true; BYO runs incur the per-minute compute fee).
 *   - SELF-HOST: AUTO_DISPATCH=k8s AND a selfhost KitStore backend → the
 *     Kubernetes Job-per-run worker. The self-host billing policy drives
 *     isCloudRun: default "free" (BYO, no metering) → isCloudRun=false;
 *     AUTO_SELFHOST_BILLING=managed → isCloudRun=true so the metered compute fee
 *     applies (the worker then uses the selfhost Postgres credit ledger).
 *   - Every other configuration (dev, local, unset) keeps the in-process
 *     dispatcher.
 *
 * This MUST no-op to in-process when the envs are unset so tests that call
 * setAutoDispatcher() directly stay in control (test/auto.test.ts). The
 * @aws-sdk/client-ecs and @kubernetes/client-node imports are lazy inside their
 * dispatchers, so this selection never touches a cloud client unless dispatched.
 */
let dispatcherInitialized = false;
export function initAutoDispatcher(): void {
  if (dispatcherInitialized) return;
  dispatcherInitialized = true;
  const dispatch = (process.env.AUTO_DISPATCH || "").toLowerCase();
  const kitBackend = (process.env.KITSTORE_BACKEND || "local").toLowerCase();
  if (dispatch === "fargate" && kitBackend === "aws") {
    // @aws-sdk/client-ecs is lazy-imported inside the Fargate dispatcher.
    setAutoDispatcher(fargateDispatcher, /* isCloudRun */ true);
  } else if (dispatch === "k8s" && kitBackend === "selfhost") {
    // Self-host k8s Job worker. Free billing (default) is NOT a cloud run (no
    // metered compute fee); managed billing IS (the worker uses the selfhost
    // Postgres ledger). @kubernetes/client-node is lazy-imported on dispatch.
    const managed = (process.env.AUTO_SELFHOST_BILLING || "free").toLowerCase() === "managed";
    setAutoDispatcher(kubeJobDispatcher, /* isCloudRun */ managed);
  }
  // else: leave the default inProcessDispatcher (isCloudRun false).
}
// Run selection once at import. Guarded above so it never throws when envs are
// unset (it no-ops to in-process). Selection deliberately does NOT touch storage
// or AWS unless fargate is selected.
initAutoDispatcher();

// ---------------------------------------------------------------------------
// Public operations (shared by both auth paths)
// ---------------------------------------------------------------------------

export class AutoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoValidationError";
  }
}

/**
 * Thrown by the pre-run gate when the user's org monthly usage limit (org budgets
 * v2) is exhausted. Routes map this to a 403 (alongside approval_denied). FAIL
 * OPEN: this is thrown ONLY when Profile affirmatively reports the limit exhausted
 * (`check.allowed === false`); any Profile absence/error leaves the gate to proceed.
 */
export class MonthlyLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonthlyLimitExceededError";
  }
}

/**
 * Thrown when a metered Auto run cannot be started because the user lacks the
 * small prepaid balance needed to cover the v2 run fee's minimum (the flat
 * invocation fee plus the first billable active-minute). Applies to managed AND
 * BYO runs. Routes map this to a 402 (Payment Required).
 */
export class InsufficientComputeBalanceError extends Error {
  readonly requiredCents: number;
  readonly balanceCents: number;
  constructor(message: string, requiredCents: number, balanceCents: number) {
    super(message);
    this.name = "InsufficientComputeBalanceError";
    this.requiredCents = requiredCents;
    this.balanceCents = balanceCents;
  }
}

/** The `http_fetch` sandbox tool. Available to a run ONLY when the approval's
 *  networkPolicy is an allowlist AND `http_fetch` is in its toolAllowlist
 *  (auto-core enforces both). The UI surfaces it as an opt-in checkbox. */
export const HTTP_FETCH_TOOL = "http_fetch";

/**
 * Parses + validates a request body's networkPolicy into the auto-core Phase C
 * shape, defaulting to deny_all. Accepts either the object shape
 * ({ mode: "deny_all" } | { mode: "allowlist", hosts: [...] }) or the legacy
 * bare "deny_all" string. An allowlist with no non-empty hosts is rejected
 * (an empty allowlist would grant nothing yet still imply egress intent).
 * Each host must be a non-empty string (exact hostname or `*.suffix`).
 */
export function parseNetworkPolicy(raw: unknown): NetworkPolicy {
  // undefined/null/"deny_all" → deny_all (never widen consent).
  if (raw === undefined || raw === null || raw === "deny_all") {
    return { mode: "deny_all" };
  }
  if (typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (r["mode"] === "deny_all") return { mode: "deny_all" };
    if (r["mode"] === "allowlist") {
      const hosts = Array.isArray(r["hosts"])
        ? (r["hosts"] as unknown[])
            .filter((h): h is string => typeof h === "string")
            .map((h) => h.trim().toLowerCase())
            .filter((h) => h.length > 0)
        : [];
      if (hosts.length === 0) {
        throw new AutoValidationError(
          "An allowlist network policy requires at least one host."
        );
      }
      // De-dupe while preserving order.
      const seen = new Set<string>();
      const unique = hosts.filter((h) => (seen.has(h) ? false : (seen.add(h), true)));
      return { mode: "allowlist", hosts: unique };
    }
  }
  // Anything unrecognized normalizes to deny_all (auto-core does the same).
  return normalizeNetworkPolicy(raw);
}

/**
 * Phase D — parse + validate an OPT-IN result-delivery config off a request body.
 *
 * Delivery is OPTIONAL "notify on completion": absent / null / an empty object →
 * undefined (no delivery, fully backward compatible). When present we run it
 * through auto-core's `validateDeliveryConfig`, which enforces the structural
 * schema (strict object; email[] basic-format; webhook.url + optional secret)
 * PLUS the semantic rules (https-only webhook url, basic email format). Any
 * violation is rethrown as an AutoValidationError so the routes surface it as a
 * 400. The returned (parsed/normalized) config is threaded onto the run/schedule/
 * webhook record; the worker reads it off the run at completion to deliver.
 */
export function parseDeliveryConfig(raw: unknown): DeliveryConfig | undefined {
  // Treat undefined/null/empty-object as "no delivery" (never invent delivery).
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw as object).length === 0) {
    return undefined;
  }
  try {
    return validateDeliveryConfig(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "invalid delivery config";
    throw new AutoValidationError(`Invalid delivery config: ${detail}`);
  }
}

/** Create a standing approval. Phase C: an optional networkPolicy (deny_all
 *  default, or an allowlist of hosts) opts the kit's runs into guarded https
 *  egress. The `http_fetch` tool is honored only when it is BOTH in the
 *  toolAllowlist AND the policy is an allowlist (auto-core enforces this); to
 *  avoid a dead opt-in we drop `http_fetch` from the allowlist when the policy
 *  is deny_all. */
export async function createApproval(input: {
  userId: string;
  kitRef: KitRef;
  toolAllowlist: string[];
  maxBudgetCents: number;
  networkPolicy?: NetworkPolicy;
}): Promise<AutoApproval> {
  if (!Number.isInteger(input.maxBudgetCents) || input.maxBudgetCents <= 0) {
    throw new AutoValidationError("maxBudgetCents must be a positive integer (US cents).");
  }
  const networkPolicy = input.networkPolicy ?? { mode: "deny_all" };
  const toolAllowlist =
    networkPolicy.mode === "allowlist"
      ? input.toolAllowlist
      : input.toolAllowlist.filter((t) => t !== HTTP_FETCH_TOOL);
  const storage = await getAutoStorage();
  const createInput: CreateApprovalInput = {
    userId: input.userId,
    kitRef: input.kitRef,
    toolAllowlist,
    maxBudgetCents: input.maxBudgetCents,
    scope: "workspace_read_write",
    networkPolicy,
    createdAt: now()
  };
  return storage.approvals.createApproval(createInput);
}

/** List a user's standing approvals. */
export async function listApprovals(userId: string): Promise<AutoApproval[]> {
  const storage = await getAutoStorage();
  return storage.approvals.listApprovalsByUser(userId);
}

/** Revoke a standing approval (ownership-checked). Returns null if the approval
 *  does not exist or belongs to another user (treated as 404 by the route). */
export async function revokeApproval(userId: string, approvalId: string): Promise<AutoApproval | null> {
  const storage = await getAutoStorage();
  const owned = (await storage.approvals.listApprovalsByUser(userId)).find((a) => a.id === approvalId);
  if (!owned) return null;
  const updated = await storage.approvals.revokeApproval(approvalId, now());
  return updated ?? null;
}

/**
 * Start a run: enforce the standing-approval gate (a matching, non-revoked
 * approval must exist AND budgetCents <= approval.maxBudgetCents), persist the
 * queued run, then DISPATCH it. The approval gate is checked HERE (so we can
 * reject with a 403 before creating the run) and is ALSO re-checked inside
 * auto-core's processAutoRun (defense in depth).
 *
 * @throws AutoValidationError       on a bad budget / missing input (→ 400).
 * @throws ApprovalDeniedError       when no approval matches or budget > ceiling
 *                                   (→ 403). Re-uses auto-core's error type.
 */
export async function startRun(input: {
  userId: string;
  kitRef: KitRef;
  prompt: string;
  budgetCents: number;
  model?: string;
  files?: { path: string; content: string }[];
  /** Phase C: out-of-band staged input files (uploaded to S3 via presigned PUT).
   *  Persisted on the run as `inputFiles`; the worker hydrates them into the
   *  workspace `inputs/` dir before execution. */
  inputFiles?: AutoRunInputFileRef[];
  kitContext: KitContextOptions;
  /** Phase D: OPT-IN result delivery (email + signed webhook). Persisted on the
   *  run; the worker reads it off the run at completion and delivers. Absent →
   *  no delivery. For scheduled/webhook-fired runs the sweep / consumeWebhook
   *  createAndDispatch COPIES the schedule's/webhook's config onto the run here. */
  deliveryConfig?: DeliveryConfig;
  /** How this run was triggered. Defaults to "on_demand" (Phase A). The Phase B
   *  scheduler passes "schedule" + scheduleId; the Phase C webhook consumer passes
   *  "webhook" + webhookId — the SAME create + gate + dispatch path is reused. */
  trigger?: "on_demand" | "schedule" | "webhook";
  /** The AutoSchedule that produced this run (only with trigger "schedule"). */
  scheduleId?: string;
  /** The AutoWebhook that produced this run (only with trigger "webhook"). */
  webhookId?: string;
  /** Per-run inference-mode override ("managed" | "byo"). Absent → the user's
   *  account preference applies. A protected/paid kit ignores this (forced
   *  managed). */
  inferenceModeOverride?: "managed" | "byo";
}): Promise<AutoRun> {
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
    throw new AutoValidationError("A run input prompt is required.");
  }
  // Budget is a non-negative integer (US cents). 0 = UNLIMITED — resolved below
  // to the kit's approval ceiling, so a run always carries a positive effective
  // cap (keeps the per-kit safety + the v2 hold/settle billing intact).
  if (!Number.isInteger(input.budgetCents) || input.budgetCents < 0) {
    throw new AutoValidationError("budgetCents must be a non-negative integer (US cents); 0 = unlimited.");
  }
  const model = isManagedModel(input.model) ? input.model! : MANAGED_DEFAULT_MODEL;

  const storage = await getAutoStorage();

  // ---- Approval gate (pre-create) ----------------------------------------
  const approval = await storage.approvals.getApprovalForKit(input.userId, input.kitRef);
  if (!approval) {
    throw new ApprovalDeniedError("No standing approval exists for this kit. Create one first.");
  }
  if (approval.revokedAt !== null) {
    throw new ApprovalDeniedError("The standing approval for this kit has been revoked.");
  }
  if (input.budgetCents > approval.maxBudgetCents) {
    throw new ApprovalDeniedError(
      `Run budget (${input.budgetCents}¢) exceeds the approval ceiling (${approval.maxBudgetCents}¢).`
    );
  }
  // 0 (unlimited) → the approval ceiling: "unlimited" means "use the full
  // approved budget" rather than a separate per-run cap. A positive request is
  // used as-is (already bounded by the ceiling check above).
  const effectiveBudgetCents = input.budgetCents > 0 ? input.budgetCents : approval.maxBudgetCents;

  // ---- Pre-run prompt-extraction guard (M6 content protection) -----------
  // For a PROTECTED (paid / online-only) kit the system prompt is the seller's IP
  // and must never reach the buyer. Refuse an obvious extraction attempt in the
  // run input UP FRONT, mirroring the interactive gateway turn route. The cheap
  // local heuristic runs FIRST, so we only pay the Market `isProtectedKit`
  // round-trip when the prompt actually looks like an extraction attempt — a
  // benign run never incurs the extra call. Best-effort: paraphrase / inference
  // extraction is not caught here (it's also masked downstream by output
  // redaction; both are deterrents, not guarantees — see leakage-guard.ts).
  if (isPromptExtractionAttempt(input.prompt) && (await isProtectedKit(input.kitRef, input.kitContext))) {
    throw new AutoValidationError(
      "This run looks like an attempt to extract a protected kit's underlying instructions, which can't be shared. Rephrase your task to use the kit's capabilities instead."
    );
  }

  // ---- Org monthly-usage gate (org budgets v2) ---------------------------
  // If the user's org has monthly usage limits set and they're exhausted, block
  // the run BEFORE create/dispatch (a clean 403, mirroring the approval gate).
  // FAIL OPEN: checkOrgUsage returns undefined whenever Profile is disabled /
  // unreachable / has no single matching org, in which case the run proceeds.
  // Only an AFFIRMATIVE `allowed === false` blocks. The post-run record hook
  // (wired into the run-driver) accumulates usage on completion.
  const usagePeriod = new Date().toISOString().slice(0, 7); // UTC YYYY-MM
  const usage = await checkOrgUsage(input.userId, usagePeriod);
  if (usage?.found && usage.check && usage.check.allowed === false) {
    throw new MonthlyLimitExceededError(
      "This organization's monthly usage limit has been reached."
    );
  }

  // ---- Resolve billing mode (server-chosen) ------------------------------
  // protected/paid kit → forced managed; configured BYO Anthropic provider →
  // BYO (no inference debit). isCloudRun is the active dispatcher's nature.
  const billing = await resolveAutoBilling({
    userId: input.userId,
    kitRef: input.kitRef,
    isCloudRun: isCloudRunDispatcher(),
    kitContext: input.kitContext,
    ...(input.inferenceModeOverride ? { inferenceModeOverride: input.inferenceModeOverride } : {})
  });

  // ---- Auto v2 run-fee balance pre-check ---------------------------------
  // Every METERED run (managed AND BYO) incurs the v2 run fee: a flat invocation
  // fee debited at start + a per-active-minute fee. Require enough prepaid
  // balance to cover the MINIMUM (invocation + the first active-minute, the
  // latter waived while free minutes remain this month) BEFORE starting, so the
  // user gets a clean 402 instead of a run that fails on the driver's debit /
  // reserveHold. This gates BYO the SAME as managed — a BYO user pays their own
  // provider for tokens but still owes the v2 run fee, so they need a balance.
  //
  // BYO ACCOUNT AUTO-CREATION: a BYO user may have never topped up, so no ledger
  // account row exists yet. We ensureAccount here (idempotent) so the balance
  // read is well-defined and the driver's later debit has an account to charge.
  // On a FREE backend (self-host) the rates are 0 → estimate 0 → no gate, and we
  // skip the ledger entirely (the free ledger ensureAccount is a harmless no-op).
  const rates = await autoV2Rates();
  if (rates.invocationFeeCents > 0 || rates.activeMinuteRateCents > 0) {
    const ledger = await selectLedger();
    // Auto-create the account (BYO users have no row until first run) so the
    // balance read + the driver's debit have a target. Idempotent.
    await ledger.ensureAccount(input.userId, now());
    const account = await ledger.getAccount(input.userId);
    const balance = account?.availableBalanceCents ?? 0;
    // Free active-minutes remaining this UTC month (the first active-minute is
    // free while any remain, so it doesn't count toward the minimum estimate).
    const freeUsed = await ledger.getFreeMinutesUsed(input.userId, utcYearMonth(now()));
    const freeRemaining = Math.max(0, rates.freeActiveMinutesPerMonth - freeUsed);
    const requiredCents = estimateMinRunCostCents(rates, freeRemaining);
    if (requiredCents > 0 && balance < requiredCents) {
      throw new InsufficientComputeBalanceError(
        "Web Auto requires a small prepaid balance for the run fee (invocation + active-minutes). Add credits to continue.",
        requiredCents,
        balance
      );
    }
  }

  // ---- Create the queued run ---------------------------------------------
  const createInput: CreateRunInput = {
    userId: input.userId,
    kitRef: input.kitRef,
    input: {
      prompt: input.prompt,
      ...(input.files && input.files.length > 0 ? { files: input.files } : {})
    },
    budgetCents: effectiveBudgetCents,
    model,
    createdAt: now(),
    inferenceMode: billing.inferenceMode,
    isCloudRun: billing.isCloudRun,
    // Phase B provenance: scheduler-fired runs carry trigger "schedule" +
    // scheduleId; on-demand runs default to "on_demand" (back-compat).
    trigger: input.trigger ?? "on_demand",
    ...(input.scheduleId !== undefined ? { scheduleId: input.scheduleId } : {}),
    // Phase C: webhook-fired runs carry trigger "webhook" + webhookId.
    ...(input.webhookId !== undefined ? { webhookId: input.webhookId } : {}),
    // Phase C: out-of-band staged input-file manifest (hydrated by the worker).
    ...(input.inputFiles && input.inputFiles.length > 0 ? { inputFiles: input.inputFiles } : {}),
    // Phase D: opt-in result delivery (email + signed webhook). Persisted on the
    // run so the worker can deliver at completion. Scheduled/webhook runs inherit
    // this from the schedule/webhook (the createAndDispatch paths pass it through).
    ...(input.deliveryConfig ? { deliveryConfig: input.deliveryConfig } : {})
  };
  const run = await storage.runs.createRun(createInput);

  // ---- Stage the managed kit package (writer; the missing half) ----------
  // A MANAGED run's kit context is read server-side by the gateway/worker from
  // object storage at its systemPromptRef. Stage the package now so the reader
  // finds it. No-op for BYO runs and when no S3 bucket is configured (in-process
  // dev resolves the prompt directly). Staging failure must NOT abort the run —
  // the resolver degrades to the default prompt on a miss — so we swallow.
  try {
    await stageManagedKitPackage(run, approval, billing);
  } catch {
    /* staged-package miss degrades to the default prompt in the reader */
  }

  // ---- Dispatch (fire-and-forget) ----------------------------------------
  await dispatcher(run.id, input.kitContext, billing);

  return run;
}

/** List a user's runs. */
export async function listRuns(userId: string, limit = 50): Promise<AutoRun[]> {
  const storage = await getAutoStorage();
  return storage.runs.listRunsByUser(userId, limit);
}

/** Get a single run, ownership-checked. Returns null for missing OR cross-user
 *  runs (the route treats both as 404). */
export async function getRun(userId: string, runId: string): Promise<AutoRun | null> {
  const storage = await getAutoStorage();
  const run = await storage.runs.getRun(runId);
  if (!run || run.userId !== userId) return null;
  return run;
}

// ---------------------------------------------------------------------------
// Worker (internal service-key) path — NO ownership check
// ---------------------------------------------------------------------------

/**
 * Get a run by id WITHOUT an ownership check. This is the INTERNAL worker path:
 * the hosted Fargate worker loads the run it was handed by id alone (it has no
 * userId), and the SERVICE KEY on the internal endpoint IS the authorization. Do
 * NOT call this from any user-facing (cookie/bearer) route — use getRun(userId,
 * runId) there, which enforces ownership.
 */
export async function getRunForWorker(runId: string): Promise<AutoRun | null> {
  const storage = await getAutoStorage();
  return (await storage.runs.getRun(runId)) ?? null;
}

/** The JSON-serializable kit context + billing the hosted worker needs to run a
 *  job. Contains NO ChatProvider instances — only the raw BYO provider config so
 *  the worker can construct its own provider. The systemPrompt/kitContext are
 *  returned ONLY to the service-key caller and are never persisted on the run or
 *  exposed to the browser. */
export interface WorkerContext {
  model: string;
  systemPrompt?: string;
  kitContext?: string;
  tools: ToolDefinition[];
  toolNames: string[];
  inferenceMode: "managed" | "byo";
  /** M6: true for a PROTECTED (paid / online-only) Market kit. The worker uses it
   *  to redact any verbatim leak of `systemPrompt` out of the run output /
   *  workspace files before they reach the buyer. Absent on local / free runs. */
  protected?: boolean;
  /** Raw BYO provider config (NOT a ChatProvider) when this run is BYO. The
   *  worker constructs its own provider from this via gateway-core's
   *  buildChatProvider; the apiKey is sensitive and must never be logged.
   *  Multi-provider: `providerType` selects the adapter the worker builds; `model`
   *  is an optional default model for providers that take it in their constructor. */
  byoProvider?: { providerType: AiProviderType; apiKey: string; baseUrl?: string; model?: string };
}

/**
 * Resolve EVERYTHING the hosted worker needs for a run, server-side, returning a
 * plain JSON-serializable object (no provider instances). Reuses the in-app
 * private helpers (makeResolveKitContext, isProtectedKit) which live in this
 * module, so protected-kit resolution works exactly like the in-app path.
 *
 * PROTECTED-KIT RESOLUTION (no user session): the worker path has no cookie/
 * bearer, so protected Market kits are resolved SERVICE-TO-SERVICE — we pass the
 * run's userId as `serviceUserId`, and protected-kits.ts calls the Market service
 * licensed-package endpoint with MARKET_SERVICE_KEY. Entitlement is STILL enforced
 * Market-side (a non-entitled user's run is refused). Local + free Market kits
 * resolve without Market. The worker NEVER holds MARKET_SERVICE_KEY and never
 * calls Market directly — only web-forge does, over this internal path.
 *
 * @throws Error if the run does not exist.
 */
export async function resolveWorkerContext(runId: string): Promise<WorkerContext> {
  const storage = await getAutoStorage();
  const run = await storage.runs.getRun(runId);
  if (!run) {
    throw new AutoValidationError(`Run not found: ${runId}`);
  }
  const approval = await storage.approvals.getApprovalForKit(run.userId, run.kitRef);
  if (!approval) {
    throw new AutoValidationError(`No standing approval for run ${runId}.`);
  }

  // SERVICE MODE: assert the run's userId so protected Market kits resolve via the
  // Market service endpoint (MARKET_SERVICE_KEY) instead of a (nonexistent) user
  // session. Entitlement is enforced Market-side.
  const serviceOpts: KitContextOptions = { serviceUserId: run.userId };

  // Resolve kit context server-to-service.
  const resolved = await makeResolveKitContext(serviceOpts)(run, approval);

  // Resolve the BYO decision the SAME way resolveAutoBilling does, but surface the
  // raw provider config (apiKey/baseUrl) instead of a constructed ChatProvider so
  // the worker can build its own. PROTECTED/paid kits FORCE managed; the account
  // inference-mode preference ("managed" forces the platform credit path) is
  // honored identically to the in-process path.
  let inferenceMode: "managed" | "byo" = "managed";
  let byoProvider: WorkerContext["byoProvider"];
  if (!(await isProtectedKit(run.kitRef, serviceOpts))) {
    const { getInferenceModePreference } = await import("@/server/core/auto-byo");
    const effectiveMode = await getInferenceModePreference(run.userId);
    if (effectiveMode !== "managed") {
      // The user's SELECTED provider (any type). Multi-provider: thread the
      // resolved providerType (+ baseUrl + model) so the worker builds the right
      // adapter via buildChatProvider.
      const stored = await (await getUserSettingsStore()).resolveProvider(run.userId);
      if (stored && stored.apiKey) {
        inferenceMode = "byo";
        byoProvider = {
          providerType: stored.providerType,
          apiKey: stored.apiKey,
          ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
          ...(stored.defaultModel ? { model: stored.defaultModel } : {})
        };
      } else {
        // ORG SHARED KEY fallback (same precedence as resolveAutoBilling): no key
        // of the user's own → their team org's shared key FOR THE EFFECTIVE
        // PROVIDER TYPE (the user's selected provider's type, else anthropic),
        // BEFORE the operator key. Fails open (undefined) so the worker still falls
        // back to the operator key.
        const orgProviderType: AiProviderType = stored?.providerType ?? "anthropic";
        const org = await resolveOrgApiKey(run.userId, orgProviderType);
        if (org) {
          inferenceMode = "byo";
          byoProvider = {
            providerType: org.providerType,
            apiKey: org.apiKey,
            ...(org.baseUrl ? { baseUrl: org.baseUrl } : {})
          };
        }
      }
    }
  }

  return {
    model: run.model,
    ...(resolved.systemPrompt !== undefined ? { systemPrompt: resolved.systemPrompt } : {}),
    ...(resolved.kitContext !== undefined ? { kitContext: resolved.kitContext } : {}),
    tools: resolved.tools,
    toolNames: resolved.toolNames,
    // M6: surface protectedness to the worker so it redacts the run output / files.
    ...(resolved.protected ? { protected: true } : {}),
    inferenceMode,
    ...(byoProvider ? { byoProvider } : {})
  };
}

/** Kill-switch: request cancellation of a run, ownership-checked. Returns false
 *  if the run is missing / not owned (→ 404). Idempotent. */
export async function cancelRun(userId: string, runId: string): Promise<boolean> {
  const storage = await getAutoStorage();
  const run = await storage.runs.getRun(runId);
  if (!run || run.userId !== userId) return false;
  await storage.runs.requestCancel(runId);
  return true;
}

/** Normalizes a request body's kitRef shape into a typed KitRef, or throws
 *  AutoValidationError (→ 400). Shared by both auth paths. */
export function parseKitRef(raw: unknown): KitRef {
  if (!raw || typeof raw !== "object") {
    throw new AutoValidationError("kitRef is required.");
  }
  const r = raw as Record<string, unknown>;
  const source = r["source"];
  if (source === "market") {
    const marketKitId = typeof r["marketKitId"] === "string" ? r["marketKitId"] : undefined;
    const slug = typeof r["slug"] === "string" ? r["slug"] : undefined;
    if (!marketKitId) {
      throw new AutoValidationError('A market kitRef requires "marketKitId".');
    }
    return { source: "market", marketKitId, ...(slug ? { slug } : {}) };
  }
  if (source === "local") {
    const localKitId = typeof r["localKitId"] === "string" ? r["localKitId"] : undefined;
    if (!localKitId) {
      throw new AutoValidationError('A local kitRef requires "localKitId".');
    }
    return { source: "local", localKitId };
  }
  throw new AutoValidationError('kitRef.source must be "market" or "local".');
}

// ===========================================================================
// AgentKitAuto — Phase B: scheduled (cron) runs
//
// A standing AutoSchedule fires an autonomous run of a kit on a recurring cron
// cadence, UNDER an existing standing approval, bounded by a REQUIRED per-run
// budget. The scheduling ENGINE (cron eval, due-selection, double-fire
// prevention, per-schedule resilience) lives in @agentkitforge/auto-core
// (runDueSchedules + nextFireAfter). This module only:
//   - validates + persists schedules (CRUD), reusing the Phase A approval gate;
//   - provides the injected createAndDispatch that turns a due schedule into a
//     run via the EXACT same path startRun uses (approval gate, billing
//     resolution, run create, dispatcher) with trigger "schedule" + scheduleId.
//
// AUTH: schedule CRUD is userId-keyed and called by both auth paths (cookie +
// bearer) exactly like runs/approvals. The sweep is the THIRD (service-key) path.
// ===========================================================================

/** Default cron timezone when the caller omits one. */
const DEFAULT_SCHEDULE_TZ = "UTC";

/** Validates a cron string; rethrows as AutoValidationError (→ 400). */
function assertValidCron(cron: string): void {
  if (typeof cron !== "string" || cron.trim().length === 0) {
    throw new AutoValidationError("A cron expression is required.");
  }
  try {
    validateCron(cron);
  } catch (err) {
    const detail = err instanceof CronParseError ? err.message : "invalid cron expression";
    throw new AutoValidationError(`Invalid cron expression: ${detail}`);
  }
}

/** Validates a timezone by attempting to compute a next fire; bad zones throw
 *  CronParseError from nextFireAfter → surfaced as AutoValidationError. Returns
 *  the computed first nextRunAt so callers don't recompute. */
function computeNextRunAt(cron: string, fromISO: string, timezone: string): string {
  try {
    return nextFireAfter(cron, fromISO, timezone);
  } catch (err) {
    const detail = err instanceof CronParseError ? err.message : "invalid cron/timezone";
    throw new AutoValidationError(`Cannot schedule: ${detail}`);
  }
}

/**
 * Re-checks that a standing approval valid for (userId, kitRef) exists, is not
 * revoked, covers budgetCents, AND that the supplied approvalId matches it. A
 * schedule MUST reference a real standing approval the user owns (CLAUDE.md / the
 * task spec) — a schedule never widens consent. Throws ApprovalDeniedError (403)
 * / AutoValidationError (400) on failure; returns the matched approval.
 */
async function requireScheduleApproval(input: {
  userId: string;
  kitRef: KitRef;
  budgetCents: number;
  approvalId: string;
}): Promise<AutoApproval> {
  const storage = await getAutoStorage();
  const approval = await storage.approvals.getApprovalForKit(input.userId, input.kitRef);
  if (!approval) {
    throw new ApprovalDeniedError("No standing approval exists for this kit. Create one first.");
  }
  if (approval.revokedAt !== null) {
    throw new ApprovalDeniedError("The standing approval for this kit has been revoked.");
  }
  // The schedule must point at THIS user's matching approval.
  if (approval.id !== input.approvalId) {
    throw new AutoValidationError(
      "approvalId does not match the standing approval for this kit."
    );
  }
  if (input.budgetCents > approval.maxBudgetCents) {
    throw new ApprovalDeniedError(
      `Schedule budget (${input.budgetCents}¢) exceeds the approval ceiling (${approval.maxBudgetCents}¢).`
    );
  }
  return approval;
}

/**
 * Create a standing schedule. Validates cron (auto-core validateCron), the
 * standing approval (must belong to the user + match kitRef + cover the budget),
 * the per-run budget (REQUIRED), the model, and the timezone; computes the
 * initial nextRunAt via nextFireAfter(cron, now, tz).
 *
 * @throws AutoValidationError  bad cron/timezone/budget/model/approval mismatch (→ 400).
 * @throws ApprovalDeniedError  no matching/over-ceiling approval (→ 403).
 */
export async function createSchedule(input: {
  userId: string;
  kitRef: KitRef;
  cron: string;
  timezone?: string;
  prompt: string;
  budgetCents: number;
  model?: string;
  approvalId: string;
  files?: { path: string; content: string }[];
  /** Phase D: opt-in result delivery copied onto every run this schedule fires. */
  deliveryConfig?: DeliveryConfig;
}): Promise<AutoSchedule> {
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
    throw new AutoValidationError("A schedule task prompt is required.");
  }
  if (!Number.isInteger(input.budgetCents) || input.budgetCents < 0) {
    throw new AutoValidationError("budgetCents must be a non-negative integer (US cents); 0 = unlimited.");
  }
  if (typeof input.approvalId !== "string" || input.approvalId.trim().length === 0) {
    throw new AutoValidationError("approvalId is required.");
  }
  assertValidCron(input.cron);
  const timezone = input.timezone && input.timezone.trim().length > 0 ? input.timezone : DEFAULT_SCHEDULE_TZ;
  const model = isManagedModel(input.model) ? input.model! : MANAGED_DEFAULT_MODEL;

  // Approval gate (same semantics as startRun) — and approvalId must match.
  await requireScheduleApproval({
    userId: input.userId,
    kitRef: input.kitRef,
    budgetCents: input.budgetCents,
    approvalId: input.approvalId
  });

  const createdAt = now();
  const nextRunAt = computeNextRunAt(input.cron, createdAt, timezone);

  const storage = await getAutoStorage();
  const createInput: CreateScheduleInput = {
    userId: input.userId,
    kitRef: input.kitRef,
    cron: input.cron,
    timezone,
    input: {
      prompt: input.prompt,
      ...(input.files && input.files.length > 0 ? { files: input.files } : {})
    },
    budgetCents: input.budgetCents,
    model,
    approvalId: input.approvalId,
    enabled: true,
    createdAt,
    nextRunAt,
    // Phase D: opt-in delivery stored on the schedule; the sweep copies it onto
    // every run it fires.
    ...(input.deliveryConfig ? { deliveryConfig: input.deliveryConfig } : {})
  };
  return storage.schedules.createSchedule(createInput);
}

/** List a user's schedules. */
export async function listSchedules(userId: string): Promise<AutoSchedule[]> {
  const storage = await getAutoStorage();
  return storage.schedules.listSchedulesByUser(userId);
}

/** Get a single schedule, ownership-checked. Null for missing/cross-user (→ 404). */
export async function getSchedule(userId: string, scheduleId: string): Promise<AutoSchedule | null> {
  const storage = await getAutoStorage();
  const s = await storage.schedules.getSchedule(scheduleId);
  if (!s || s.userId !== userId) return null;
  return s;
}

/**
 * Patch a schedule (enable/disable/edit), ownership-checked. Returns null for a
 * missing/cross-user schedule (→ 404). When cron/timezone/enabled change, the
 * nextRunAt is recomputed here (auto-core requires the caller to supply it). When
 * budget/approval/kitRef-affecting fields change, the approval gate is re-checked.
 *
 * @throws AutoValidationError / ApprovalDeniedError on invalid edits.
 */
export async function updateSchedule(
  userId: string,
  scheduleId: string,
  patch: {
    cron?: string;
    timezone?: string;
    prompt?: string;
    budgetCents?: number;
    model?: string;
    approvalId?: string;
    enabled?: boolean;
    files?: { path: string; content: string }[];
  }
): Promise<AutoSchedule | null> {
  const storage = await getAutoStorage();
  const current = await storage.schedules.getSchedule(scheduleId);
  if (!current || current.userId !== userId) return null;

  // Merge to the effective post-patch values used for validation + recompute.
  const cron = patch.cron !== undefined ? patch.cron : current.cron;
  const timezone =
    patch.timezone !== undefined && patch.timezone.trim().length > 0
      ? patch.timezone
      : patch.timezone === undefined
        ? current.timezone
        : DEFAULT_SCHEDULE_TZ;
  const budgetCents = patch.budgetCents !== undefined ? patch.budgetCents : current.budgetCents;
  const approvalId = patch.approvalId !== undefined ? patch.approvalId : current.approvalId;
  const enabled = patch.enabled !== undefined ? patch.enabled : current.enabled;

  if (patch.cron !== undefined) assertValidCron(cron);
  if (patch.budgetCents !== undefined && (!Number.isInteger(budgetCents) || budgetCents < 0)) {
    throw new AutoValidationError("budgetCents must be a non-negative integer (US cents); 0 = unlimited.");
  }

  // Re-check the approval gate when anything that touches consent/budget changed.
  if (patch.budgetCents !== undefined || patch.approvalId !== undefined) {
    await requireScheduleApproval({
      userId,
      kitRef: current.kitRef,
      budgetCents,
      approvalId
    });
  }

  const update: UpdateScheduleInput = { updatedAt: now() };
  if (patch.cron !== undefined) update.cron = patch.cron;
  if (patch.timezone !== undefined) update.timezone = timezone;
  if (patch.budgetCents !== undefined) update.budgetCents = budgetCents;
  if (patch.approvalId !== undefined) update.approvalId = approvalId;
  if (patch.model !== undefined) {
    update.model = isManagedModel(patch.model) ? patch.model : MANAGED_DEFAULT_MODEL;
  }
  if (patch.enabled !== undefined) update.enabled = enabled;
  if (patch.prompt !== undefined || patch.files !== undefined) {
    const prompt = patch.prompt !== undefined ? patch.prompt : current.input.prompt;
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new AutoValidationError("A schedule task prompt is required.");
    }
    const files = patch.files !== undefined ? patch.files : current.input.files;
    update.input = { prompt, ...(files && files.length > 0 ? { files } : {}) };
  }

  // Recompute nextRunAt when the cadence/timezone changed, OR when (re)enabling a
  // schedule (so a long-disabled schedule doesn't fire for every missed slot).
  const cadenceChanged = patch.cron !== undefined || patch.timezone !== undefined;
  const reEnabling = patch.enabled === true && !current.enabled;
  if (cadenceChanged || reEnabling) {
    update.nextRunAt = computeNextRunAt(cron, now(), timezone);
  }

  const updated = await storage.schedules.updateSchedule(scheduleId, update);
  return updated ?? null;
}

/** Delete a schedule, ownership-checked. Returns false for missing/cross-user. */
export async function deleteSchedule(userId: string, scheduleId: string): Promise<boolean> {
  const storage = await getAutoStorage();
  const s = await storage.schedules.getSchedule(scheduleId);
  if (!s || s.userId !== userId) return false;
  await storage.schedules.deleteSchedule(scheduleId);
  return true;
}

/**
 * Run one scheduling SWEEP (the per-minute cron tick). This is the THIRD
 * (service-key) path — there is NO user session; the schedule's OWN userId drives
 * every per-run decision.
 *
 * It builds `createAndDispatch(schedule)` which constructs a run from the schedule
 * and runs the EXACT same path startRun uses (approval gate + billing resolution +
 * run create + dispatch via the selected dispatcher — Fargate on hosted), stamping
 * trigger "schedule" + scheduleId. auto-core's runDueSchedules then:
 *   - selects due (enabled, nextRunAt <= now) schedules off the dueIndex;
 *   - re-checks each against the standing approval (defense in depth);
 *   - advances nextRunAt BEFORE returning to prevent double-firing;
 *   - isolates per-schedule failures into the summary (one bad schedule never
 *     aborts the sweep).
 *
 * The sweep is quick: it only creates + dispatches; the runs themselves execute on
 * Fargate (hosted). Reads from the same KitStore-backed auto deps.
 */
export async function runScheduleSweep(): Promise<ScheduleSweepSummary> {
  const storage = await getAutoStorage();

  const createAndDispatch = async (schedule: AutoSchedule): Promise<AutoRun> => {
    // SERVICE MODE: no user session. The schedule's userId drives kit-context
    // resolution (protected Market kits resolve server-to-service via
    // MARKET_SERVICE_KEY). Mirrors the worker path's serviceUserId opts.
    return startRun({
      userId: schedule.userId,
      kitRef: schedule.kitRef,
      prompt: schedule.input.prompt,
      budgetCents: schedule.budgetCents,
      model: schedule.model,
      ...(schedule.input.files && schedule.input.files.length > 0
        ? { files: schedule.input.files }
        : {}),
      kitContext: { serviceUserId: schedule.userId },
      // Phase D: COPY the schedule's opt-in delivery config onto the fired run so
      // scheduled runs deliver their result exactly like an on-demand run does.
      ...(schedule.deliveryConfig ? { deliveryConfig: schedule.deliveryConfig } : {}),
      trigger: "schedule",
      scheduleId: schedule.id
    });
  };

  return runDueSchedules({
    deps: { schedules: storage.schedules, approvals: storage.approvals },
    now: now(),
    createAndDispatch
  });
}

// ===========================================================================
// AgentKitAuto — Phase C: user-provided run inputs (presigned S3 upload)
//
// The browser/Forge uploads each input file's BYTES directly to S3 via a
// presigned PUT URL we issue here, under the per-run-pending input prefix
// `auto-inputs/{stagingId}/...`. The resulting manifest (workspace-relative
// path + S3 key) is then threaded into startRun as `inputFiles`; the worker
// (auto-core's S3InputStore) GETs each object and hydrates it into the run
// workspace `inputs/` dir before execution.
//
// SAFETY: filenames are path-confined (auto-core's confineInputPath rejects
// absolute paths + `..` traversal); the S3 key always lives under the
// `auto-inputs/` prefix the SSR user is scoped to. We presign on the SAME
// FORGE_AWS_* credentials/region as the rest of the app.
// ===========================================================================

/** A single presigned input-upload slot returned to the client. */
export interface InputUploadSlot {
  /** Workspace-relative path under `inputs/` (path-confined). */
  path: string;
  /** The S3 object key the client PUTs to (under `auto-inputs/`). */
  s3Key: string;
  /** The presigned PUT URL (expires shortly). */
  uploadUrl: string;
}

/** Thrown when input uploads are requested but no S3 inputs bucket is configured. */
export class InputStorageUnconfiguredError extends Error {
  constructor() {
    super("Run input uploads require an S3 inputs bucket (AUTO_INPUTS_BUCKET).");
    this.name = "InputStorageUnconfiguredError";
  }
}

/**
 * Issue presigned S3 PUT URLs for a batch of run input files. Returns one slot
 * per file (confined path + S3 key + URL) plus the `inputFiles` MANIFEST to
 * thread into startRun. `stagingId` namespaces this batch's objects (a random
 * id, NOT yet the run id — the run is created after the uploads succeed); the
 * S3InputStore reads the manifest's explicit `s3Key`, so the staging id never
 * needs to match the eventual run id.
 *
 * @throws AutoValidationError           on an empty/invalid file list or bad path.
 * @throws InputStorageUnconfiguredError when no inputs bucket is configured.
 */
export async function createInputUploadUrls(input: {
  userId: string;
  files: { path: string; contentType?: string }[];
}): Promise<{ stagingId: string; slots: InputUploadSlot[]; inputFiles: AutoRunInputFileRef[] }> {
  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw new AutoValidationError("At least one input file is required.");
  }
  if (input.files.length > 20) {
    throw new AutoValidationError("At most 20 input files may be uploaded per run.");
  }
  const bucket = autoInputsBucket();
  if (!bucket) {
    throw new InputStorageUnconfiguredError();
  }

  // The staging id namespaces this batch under the per-user input prefix; it is
  // randomised and includes the userId so a leaked URL can't target another
  // user's prefix (the SSR user is scoped to auto-inputs/* regardless).
  const stagingId = `${input.userId}/${randomUUID()}`;

  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const env = awsClientEnv();
  const client = new S3Client({
    region: env.region,
    ...(env.credentials ? { credentials: env.credentials } : {})
  });

  const slots: InputUploadSlot[] = [];
  const inputFiles: AutoRunInputFileRef[] = [];
  for (const f of input.files) {
    let confined: string;
    try {
      confined = confineInputPath(typeof f.path === "string" ? f.path : "");
    } catch {
      throw new AutoValidationError(`Invalid input file path: ${String(f.path)}`);
    }
    // inputObjectKey builds the canonical `auto-inputs/{stagingId}/{tail}` key.
    const s3Key = inputObjectKey(stagingId, confined);
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      ...(typeof f.contentType === "string" && f.contentType ? { ContentType: f.contentType } : {})
    });
    const uploadUrl = await getSignedUrl(client, command, { expiresIn: 900 });
    slots.push({ path: confined, s3Key, uploadUrl });
    inputFiles.push({ path: confined, s3Key });
  }
  return { stagingId, slots, inputFiles };
}

/** Normalizes a request body's inputFiles manifest (path + s3Key) into typed
 *  AutoRunInputFileRefs, re-confining each path. Drops malformed entries. Shared
 *  by both auth paths' run-create routes. */
export function parseInputFiles(raw: unknown): AutoRunInputFileRef[] {
  if (!Array.isArray(raw)) return [];
  const out: AutoRunInputFileRef[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec["path"] !== "string") continue;
    let confined: string;
    try {
      confined = confineInputPath(rec["path"]);
    } catch {
      continue;
    }
    out.push({
      path: confined,
      ...(typeof rec["s3Key"] === "string" && rec["s3Key"] ? { s3Key: rec["s3Key"] } : {})
    });
  }
  return out;
}

// ===========================================================================
// AgentKitAuto — Phase C: inbound webhook triggers
//
// A standing AutoWebhook fires an autonomous run of a kit when a third-party
// service POSTs to its public ingest URL, authed ONLY by a per-webhook SECRET
// (the FOURTH auth path — never cookie/bearer/service-key). The fire logic
// (secret verify + approval gate + run create + dispatch + recordFire) lives in
// auto-core's consumeWebhook; this module only:
//   - validates + persists webhooks (CRUD), reusing the approval gate;
//   - generates the plaintext secret server-side, stores ONLY its hash, and
//     returns the plaintext ONCE on create (never retrievable again);
//   - provides the injected createAndDispatch that turns a fire into a run via
//     the EXACT same startRun path schedules use, stamping trigger "webhook".
//
// AUTH: webhook CRUD is userId-keyed and called by both the cookie + bearer
// paths exactly like runs/approvals/schedules. The INGEST is the fourth path
// (per-webhook secret), handled in the public /api/hooks route.
// ===========================================================================

/** Re-checks that a non-revoked standing approval for (userId, kitRef) exists,
 *  covers budgetCents, AND matches the supplied approvalId — exactly like
 *  requireScheduleApproval. A webhook never widens consent. */
async function requireWebhookApproval(input: {
  userId: string;
  kitRef: KitRef;
  budgetCents: number;
  approvalId: string;
}): Promise<AutoApproval> {
  const storage = await getAutoStorage();
  const approval = await storage.approvals.getApprovalForKit(input.userId, input.kitRef);
  if (!approval) {
    throw new ApprovalDeniedError("No standing approval exists for this kit. Create one first.");
  }
  if (approval.revokedAt !== null) {
    throw new ApprovalDeniedError("The standing approval for this kit has been revoked.");
  }
  if (approval.id !== input.approvalId) {
    throw new AutoValidationError("approvalId does not match the standing approval for this kit.");
  }
  if (input.budgetCents > approval.maxBudgetCents) {
    throw new ApprovalDeniedError(
      `Webhook budget (${input.budgetCents}¢) exceeds the approval ceiling (${approval.maxBudgetCents}¢).`
    );
  }
  return approval;
}

/** The create-webhook result: the persisted webhook PLUS the one-time plaintext
 *  secret + the ingest URL. The secret is shown to the user ONCE and is NEVER
 *  retrievable again (only its hash is stored). */
export interface CreatedWebhook {
  webhook: AutoWebhook;
  /** The plaintext shared secret — shown ONCE; never stored or retrievable. */
  secret: string;
  /** The public ingest URL the third-party service POSTs to. */
  ingestUrl: string;
}

/**
 * Create a standing webhook. Validates the standing approval (must belong to the
 * user + match kitRef + cover the budget), generates a random secret, stores
 * ONLY its hash, and returns the plaintext secret + ingest URL ONCE.
 *
 * @throws AutoValidationError  bad budget/model/approval mismatch (→ 400).
 * @throws ApprovalDeniedError  no matching/over-ceiling approval (→ 403).
 */
export async function createWebhook(input: {
  userId: string;
  kitRef: KitRef;
  budgetCents: number;
  model?: string;
  approvalId: string;
  /** Phase D: opt-in result delivery copied onto every run this webhook fires. */
  deliveryConfig?: DeliveryConfig;
}): Promise<CreatedWebhook> {
  if (!Number.isInteger(input.budgetCents) || input.budgetCents < 0) {
    throw new AutoValidationError("budgetCents must be a non-negative integer (US cents); 0 = unlimited.");
  }
  if (typeof input.approvalId !== "string" || input.approvalId.trim().length === 0) {
    throw new AutoValidationError("approvalId is required.");
  }
  await requireWebhookApproval({
    userId: input.userId,
    kitRef: input.kitRef,
    budgetCents: input.budgetCents,
    approvalId: input.approvalId
  });

  const model = isManagedModel(input.model) ? input.model! : MANAGED_DEFAULT_MODEL;
  // Generate the plaintext secret server-side; persist ONLY its sha256 hash.
  const secret = generateWebhookSecret();
  const storage = await getAutoStorage();
  const createInput: CreateWebhookInput = {
    userId: input.userId,
    kitRef: input.kitRef,
    approvalId: input.approvalId,
    budgetCents: input.budgetCents,
    model,
    enabled: true,
    secretHash: hashWebhookSecret(secret),
    createdAt: now(),
    // Phase D: opt-in delivery stored on the webhook; consumeWebhook copies it
    // onto every run a fire produces.
    ...(input.deliveryConfig ? { deliveryConfig: input.deliveryConfig } : {})
  };
  const webhook = await storage.webhooks.createWebhook(createInput);
  return { webhook, secret, ingestUrl: webhookIngestUrl(webhook.id) };
}

/** Build the public ingest URL for a webhook id (`${APP_URL}/api/hooks/auto/{id}`). */
export function webhookIngestUrl(webhookId: string): string {
  const base = getAppUrl().replace(/\/$/, "");
  return `${base}${autoHookRoutes.ingest(webhookId)}`;
}

/** List a user's webhooks (the secretHash is never exposed by the routes; this
 *  returns the raw records — routes strip secretHash before responding). */
export async function listWebhooks(userId: string): Promise<AutoWebhook[]> {
  const storage = await getAutoStorage();
  return storage.webhooks.listWebhooksByUser(userId);
}

/** Get a single webhook, ownership-checked. Null for missing/cross-user (→ 404). */
export async function getWebhook(userId: string, webhookId: string): Promise<AutoWebhook | null> {
  const storage = await getAutoStorage();
  const w = await storage.webhooks.getWebhook(webhookId);
  if (!w || w.userId !== userId) return null;
  return w;
}

/** Enable/disable a webhook, ownership-checked. Null for missing/cross-user. */
export async function setWebhookEnabled(
  userId: string,
  webhookId: string,
  enabled: boolean
): Promise<AutoWebhook | null> {
  const storage = await getAutoStorage();
  const w = await storage.webhooks.getWebhook(webhookId);
  if (!w || w.userId !== userId) return null;
  const updated = await storage.webhooks.setEnabled(webhookId, enabled);
  return updated ?? null;
}

/** Delete a webhook, ownership-checked. False for missing/cross-user (→ 404). */
export async function deleteWebhook(userId: string, webhookId: string): Promise<boolean> {
  const storage = await getAutoStorage();
  const w = await storage.webhooks.getWebhook(webhookId);
  if (!w || w.userId !== userId) return false;
  await storage.webhooks.deleteWebhook(webhookId);
  return true;
}

export { WebhookError };

/**
 * Consume an inbound webhook fire (the FOURTH auth path — secret only). Verifies
 * the presented secret (constant-time, via auto-core's hash compare), re-checks
 * the standing approval, creates a run with trigger "webhook" + webhookId, and
 * dispatches it via the EXACT same startRun path schedules use (SERVICE MODE —
 * the webhook's userId drives kit-context resolution, no user session).
 *
 * Returns the created AutoRun. Throws WebhookError (typed reason) which the
 * ingest route maps to a status (401 for not_found/disabled/bad_secret so a
 * caller can't probe which webhooks exist; 403 for approval/budget).
 *
 * NEVER logs the secret.
 */
export async function fireWebhook(input: {
  webhookId: string;
  providedSecret: string;
  payload?: unknown;
}): Promise<AutoRun> {
  const storage = await getAutoStorage();

  // Phase D: read the webhook's opt-in delivery config up-front so the fired run
  // inherits it. auto-core's consumeWebhook builds its CreateRunInput WITHOUT a
  // deliveryConfig, so we copy it from the webhook record here (auto-core still
  // re-verifies the secret + approval before our createAndDispatch is invoked).
  const webhookRecord = await storage.webhooks.getWebhook(input.webhookId);
  const webhookDelivery = webhookRecord?.deliveryConfig;

  const createAndDispatch = async (createInput: CreateRunInput): Promise<AutoRun> => {
    // SERVICE MODE: no user session. The webhook's userId drives kit-context
    // resolution (protected Market kits resolve server-to-service via
    // MARKET_SERVICE_KEY). Mirrors the schedule sweep's createAndDispatch — we
    // re-route through startRun so the approval gate + billing + dispatch are
    // identical to an on-demand run, stamping trigger "webhook" + webhookId.
    return startRun({
      userId: createInput.userId,
      kitRef: createInput.kitRef,
      prompt: createInput.input.prompt,
      budgetCents: createInput.budgetCents,
      ...(createInput.model ? { model: createInput.model } : {}),
      kitContext: { serviceUserId: createInput.userId },
      // Phase D: COPY the webhook's opt-in delivery config onto the fired run so
      // webhook-fired runs deliver their result exactly like an on-demand run.
      // Prefer createInput.deliveryConfig (future-proof if auto-core threads it),
      // falling back to the webhook record we read above.
      ...(createInput.deliveryConfig ?? webhookDelivery
        ? { deliveryConfig: createInput.deliveryConfig ?? webhookDelivery }
        : {}),
      trigger: "webhook",
      ...(createInput.webhookId !== undefined ? { webhookId: createInput.webhookId } : {}),
      ...(createInput.inputFiles ? { inputFiles: createInput.inputFiles } : {})
    });
  };

  return consumeWebhook({
    deps: { webhooks: storage.webhooks, approvals: storage.approvals },
    webhookId: input.webhookId,
    providedSecret: input.providedSecret,
    payload: input.payload,
    now: now(),
    createAndDispatch
  });
}
