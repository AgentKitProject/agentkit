/**
 * run-task — the Fargate task main for AgentKitAuto.
 *
 * ECS launches one task per run, passing `RUN_ID` in the environment. This
 * entrypoint wires the AWS-backed storage (via the task role — no static keys),
 * the platform Anthropic provider + credit ledger, and an HTTP-backed kit-context
 * resolver, then executes the run end-to-end via `processAutoRun`.
 *
 * `runTask` is kept PURE (it throws on failure rather than calling
 * `process.exit`), so it stays unit-testable. `main()` is the process wrapper
 * and owns the EXIT-CODE CONTRACT (backoffLimit is 0 on the k8s Job path, so
 * exit codes never drive retries — they only decide whether the Job reads
 * Complete or Failed, i.e. whether the operator's KubeJobFailed alert fires):
 *
 *   EXIT 0 — the run's outcome WAS recorded. Includes every terminal status the
 *     driver returns (succeeded / failed / canceled / budget_exceeded) AND every
 *     HANDLED failure, i.e. a failure whose terminal `failed` status was
 *     successfully written (approval denied, kit-context resolution failed,
 *     driver-recorded errors). Alerting on these would be noise: the user
 *     already sees a failed run.
 *
 *   EXIT 1 — the worker itself crashed or COULD NOT record the outcome (missing
 *     env, storage unreachable, the terminal-status write failed). The run may
 *     be stuck non-terminal; KubeJobFailed firing here is meaningful.
 *
 * Security: NEVER log the system prompt, kit context, or a BYO API key. On
 * success we log only the run id + terminal status.
 */

import {
  buildChatProvider,
  createManagedRoutingProvider,
  type ChatProvider,
  type CreditLedgerRepository,
} from "@agentkitforge/gateway-core";
import { lookup } from "node:dns/promises";
import type { InferenceMode } from "../core/types.js";
import type { AutoStorageDeps, EmailSender } from "../core/ports.js";
import { makeAwsAutoDeps } from "../adapters/aws/index.js";
import { makeSesEmailSender } from "../adapters/aws/ses-email-sender.js";
import {
  ensureAutoSchema,
  makeSelfHostAutoDeps,
  PostgresRoyaltyAccrualStore,
  type PgPool,
} from "../adapters/selfhost/postgres.js";
import type { RoyaltyAccrualStore } from "../core/royalty-reconciliation.js";
import { makeSelfHostEmailSender } from "../adapters/selfhost/email-sender.js";
import { makeFreeCreditLedger } from "../adapters/selfhost/free-ledger.js";
import { HttpLedgerClient } from "../adapters/http/http-ledger-client.js";
import type { DnsResolver, FetchFn } from "../core/http-fetch.js";
import {
  fetchResolveContext,
  toResolveKitContext,
  type ResolveContextResponse,
} from "../core/http-resolve-context.js";
import type { AutoRunRepository } from "../core/ports.js";
import {
  ApprovalDeniedError,
  HandledRunFailureError,
  processAutoRun,
  type ProcessAutoRunDeps,
} from "./worker.js";

/** Real DNS resolver for webhook-delivery SSRF guard (A + AAAA). */
const dnsResolver: DnsResolver = async (hostname: string): Promise<string[]> => {
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
};

/** Global fetch adapted to the injected FetchFn shape (webhook delivery). */
const globalFetch: FetchFn = async (url, init) => {
  const res = await fetch(url, init as RequestInit | undefined);
  return {
    status: res.status,
    headers: { forEach: (cb) => res.headers.forEach(cb) },
    text: () => res.text(),
  };
};

type Env = Record<string, string | undefined>;

function requireEnv(env: Env, key: string): string {
  const value = env[key];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function parseIntEnv(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Invalid integer for ${key}: ${raw}`);
  }
  return n;
}

/** The per-backend persistence + delivery deps the worker needs. */
interface BackendDeps {
  storage: AutoStorageDeps;
  ledger: CreditLedgerRepository;
  emailSender: EmailSender;
  /**
   * True when the active ledger is the COMMERCIAL managed credit ledger (hosted /
   * metered). False when it is the inert FREE ledger (open-core / self-host).
   * Gates the Auto v2 run fee: fees are resolved + applied ONLY on the managed
   * path, so a free deployment never touches the ledger and pays nothing.
   */
  managed: boolean;
  /**
   * Durable royalty-accrual reconciliation store (M6 #5). Present ONLY on the
   * Postgres self-host/DOKS backend (it needs the same pool). Absent on the AWS
   * DynamoDB backend and skipped there — a failed premium accrual there is still
   * flagged by the driver but not durably queued (the AWS worker path is legacy).
   */
  royaltyStore?: RoyaltyAccrualStore;
}

/**
 * Selects the worker's storage/ledger/email backend from the environment so the
 * SAME worker image runs on hosted (AWS) and self-host (k8s + Postgres):
 *
 *   - AWS (default): DynamoDB storage via the task role + the Dynamo credit
 *     ledger + the SES email sender. This is the hosted Fargate path (unchanged).
 *
 *   - SELF-HOST (AUTO_BACKEND=selfhost OR KITSTORE_BACKEND=selfhost): Postgres
 *     storage (DATABASE_URL) + FsWorkspaceStore on the mounted scratch dir, the
 *     self-host (no-op) email sender (SMTP deferred; webhook delivery still
 *     works), and — per AUTO_SELFHOST_BILLING — either the inert FREE ledger
 *     (default: BYO key, no metering) or the gateway-core Postgres credit ledger
 *     ("managed"). The Auto schema is ensured idempotently on boot.
 */
async function buildBackendDeps(env: Env): Promise<BackendDeps> {
  const backend = (
    env["AUTO_BACKEND"] ||
    env["KITSTORE_BACKEND"] ||
    "aws"
  ).toLowerCase();
  const workspaceRootDir = env["AUTO_WORKSPACE_DIR"];

  if (backend === "selfhost") {
    // Lazy `pg` import — only the self-host worker path constructs a real Pool,
    // mirroring the lazy AWS-client discipline elsewhere.
    const { Pool } = await import("pg");
    const pool = new Pool({
      connectionString: requireEnv(env, "DATABASE_URL"),
    }) as unknown as PgPool;
    // Idempotent CREATE TABLE IF NOT EXISTS — a self-host worker can run before
    // the web app has created the tables.
    await ensureAutoSchema(pool);
    const storage = makeSelfHostAutoDeps({
      pool,
      ...(workspaceRootDir && workspaceRootDir.trim() !== "" ? { workspaceRootDir } : {}),
    });
    // Billing policy: FREE (default) → inert ledger (BYO, never metered).
    // "managed" billing debits the credit ledger OVER HTTP through the GATEWAY
    // SERVICE (`/gateway/ledger/*`, service-key-gated) — NOT a direct DB
    // connection. The credit ledger is OWNED BY THE GATEWAY and lives in ITS
    // database (agentkitgateway), so Stripe top-ups (gateway) and run debits
    // (this worker) hit the SAME balance; the gateway stays the sole holder of
    // its DB credentials and the only place the commercial ledger runs. Auto-core
    // no longer imports @agentkit-commercial/gateway nor touches the gateway DB.
    // When the gateway base URL / service key is absent, degrade to the inert
    // FREE ledger so the open-core / self-host path runs unmetered.
    const billing = (env["AUTO_SELFHOST_BILLING"] || "free").toLowerCase();
    const { ledger, managed } =
      billing === "managed"
        ? loadManagedLedgerWithFlag(env)
        : { ledger: makeFreeCreditLedger(), managed: false };
    // Durable royalty-accrual reconciliation store (M6 #5): over the SAME pool.
    // Harmless on free/BYO (nothing records unless a premium accrual fails).
    const royaltyStore = new PostgresRoyaltyAccrualStore(pool);
    // SMTP email sender: active when SMTP_HOST + SMTP_FROM are set in env;
    // inert (skipped) otherwise — webhook delivery still works regardless.
    return { storage, ledger, emailSender: makeSelfHostEmailSender(), managed, royaltyStore };
  }

  // AWS (hosted) — storage uses the task role (default credential chain) + the
  // SES sender. The hosted Dynamo credit ledger ("managed" metering) is a
  // COMMERCIAL feature (@agentkit-commercial/gateway) and is not bundled in the
  // open-source build, so the AWS path here runs the free / BYO ledger.
  const storage = makeAwsAutoDeps(
    workspaceRootDir && workspaceRootDir.trim() !== "" ? { workspaceRootDir } : {},
  );
  const ledger = makeFreeCreditLedger();
  const emailSender = makeSesEmailSender(
    { clientConfig: { region: env["FORGE_AWS_REGION"] || env["AWS_REGION"] || "us-east-1" } },
    env,
  );
  // AWS path runs the free / BYO ledger → not managed (no v2 fee).
  return { storage, ledger, emailSender, managed: false };
}

/** The Auto v2 run-fee rates the worker applies (US cents). 0 → disabled. */
export interface AutoV2Rates {
  invocationFeeCents: number;
  activeMinuteRateCents: number;
  /**
   * Per-user, per-calendar-month FREE active-minute allowance (Slice 2). 0 → no
   * free tier. Only ever non-zero on the hosted managed path.
   */
  freeActiveMinutesPerMonth: number;
}

/**
 * Reads the gateway internal base URL + service key from the environment. Both
 * present → the worker can reach the gateway's `/gateway/ledger/*` HTTP seam;
 * either absent → no managed billing (degrade to the inert FREE ledger).
 */
function gatewayHttpConfig(env: Env): { baseUrl: string; serviceKey: string } | undefined {
  const baseUrl = env["GATEWAY_INTERNAL_BASE_URL"];
  const serviceKey = env["GATEWAY_SERVICE_KEY"];
  if (!baseUrl || baseUrl.trim() === "" || !serviceKey || serviceKey.trim() === "") {
    return undefined;
  }
  return { baseUrl: baseUrl.trim(), serviceKey: serviceKey.trim() };
}

/**
 * Boot hardening log (Q2): when the gateway is NOT configured (the free / BYO
 * path), emit ONE info line at startup so operators can confirm the deployment
 * does no managed metering or external billing. Guarded by a module-level flag so
 * it never fires in the per-run hot path (a re-entrant call in the same process is
 * silent). A configured gateway logs nothing here (metering is the expectation).
 */
let bootLogEmitted = false;
function logBootMode(env: Env): void {
  if (bootLogEmitted) return;
  bootLogEmitted = true;
  if (!gatewayHttpConfig(env)) {
    console.info(
      "[auto] BYO/free mode — no gateway configured; no managed metering or external billing",
    );
  }
}

/**
 * Selects the worker's credit ledger from the environment:
 *   - GATEWAY_INTERNAL_BASE_URL + GATEWAY_SERVICE_KEY set → the HTTP-backed
 *     ledger (`HttpLedgerClient`) that debits the gateway ledger over the
 *     service-key-gated `/gateway/ledger/*` endpoints (`managed: true`). The
 *     gateway stays the sole holder of its DB credentials.
 *   - either absent (public / self-host) → the inert FREE ledger (never debits,
 *     `managed: false`).
 *
 * The `managed` flag gates the Auto v2 run fee so a free deployment never applies
 * it. Auto-core no longer imports @agentkit-commercial/gateway and no longer
 * connects to the gateway's Postgres directly.
 */
export function loadManagedLedgerWithFlag(
  env: Env,
): { ledger: CreditLedgerRepository; managed: boolean } {
  const cfg = gatewayHttpConfig(env);
  if (!cfg) {
    return { ledger: makeFreeCreditLedger(), managed: false };
  }
  return { ledger: new HttpLedgerClient(cfg), managed: true };
}

/**
 * Resolves the Auto v2 run-fee rates (invocation + active-minute) by FETCHING
 * them from the gateway's `/gateway/ledger/auto-v2-rates` endpoint over HTTP. The
 * moat VALUES live in the gateway (commercial), so the worker never imports them;
 * it reads them through the same service-key-gated seam it debits through.
 *
 *   - `enabled === false` (free / open-core, no managed ledger) → 0/0/0.
 *   - `enabled === true` but the gateway base URL / service key is absent, or the
 *     fetch fails → 0/0/0 (NEVER charge when the rates can't be read).
 *
 * Env overrides (operator/test escape hatch): AUTO_INVOCATION_FEE_CENTS,
 * AUTO_ACTIVE_MINUTE_RATE_CENTS, and AUTO_FREE_ACTIVE_MINUTES_PER_MONTH take
 * precedence over the fetched rates.
 *
 * `fetchImpl` is injectable for tests; production uses the global `fetch`.
 */
export async function loadAutoV2Rates(
  enabled: boolean,
  env: Env = process.env,
  fetchImpl?: typeof fetch,
): Promise<AutoV2Rates> {
  // Disabled (open-core / self-host FREE) → 0/0/0, and the env overrides below do
  // NOT bypass this gate (free stays free). Returning early also means a free
  // deployment never even fetches the rates.
  if (!enabled) {
    return { invocationFeeCents: 0, activeMinuteRateCents: 0, freeActiveMinutesPerMonth: 0 };
  }

  let invocationFeeCents = 0;
  let activeMinuteRateCents = 0;
  let freeActiveMinutesPerMonth = 0;

  const cfg = gatewayHttpConfig(env);
  if (cfg) {
    const client = new HttpLedgerClient({
      ...cfg,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    // fetchAutoV2Rates already swallows failures → 0/0/0 (never charge on error).
    const rates = await client.fetchAutoV2Rates();
    invocationFeeCents = rates.invocationFeeCents;
    activeMinuteRateCents = rates.activeMinuteRateCents;
    freeActiveMinutesPerMonth = rates.freeActiveMinutesPerMonth;
  }

  // Env override escape hatch (still hosted-managed-gated by `enabled`).
  if (env["AUTO_INVOCATION_FEE_CENTS"] !== undefined) {
    invocationFeeCents = Math.max(0, parseIntEnv(env, "AUTO_INVOCATION_FEE_CENTS", 0));
  }
  if (env["AUTO_ACTIVE_MINUTE_RATE_CENTS"] !== undefined) {
    activeMinuteRateCents = Math.max(0, parseIntEnv(env, "AUTO_ACTIVE_MINUTE_RATE_CENTS", 0));
  }
  if (env["AUTO_FREE_ACTIVE_MINUTES_PER_MONTH"] !== undefined) {
    freeActiveMinutesPerMonth = Math.max(0, parseIntEnv(env, "AUTO_FREE_ACTIVE_MINUTES_PER_MONTH", 0));
  }
  return { invocationFeeCents, activeMinuteRateCents, freeActiveMinutesPerMonth };
}

/**
 * Fetches the run's resolve-context payload, MARKING THE RUN FAILED when the
 * fetch fails. This closes the "zombie queued run" gap: the up-front resolve
 * fetch runs BEFORE processAutoRun writes any status, so a failure here (e.g.
 * HTTP 404 because the kit was deleted after dispatch — which proves the API IS
 * reachable) used to kill the worker with the run still `queued` forever.
 *
 * Failure handling:
 *   - fetch fails + the terminal `failed` write SUCCEEDS → throws
 *     HandledRunFailureError (main() → exit 0; the Job reads Complete).
 *   - fetch fails + even the status write fails → re-throws the ORIGINAL fetch
 *     error (main() → exit 1; the outcome truly went unrecorded).
 *
 * Deps are injectable (runs repo + fetchImpl) so tests drive it with fakes.
 */
export async function resolveContextOrFailRun(args: {
  runId: string;
  baseUrl: string;
  serviceKey: string;
  runs: Pick<AutoRunRepository, "updateRunStatus">;
  now: () => string;
  fetchImpl?: typeof fetch;
}): Promise<ResolveContextResponse> {
  const { runId, baseUrl, serviceKey, runs, now } = args;
  try {
    return await fetchResolveContext({
      runId,
      baseUrl,
      serviceKey,
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Clear, user-facing reason: the dominant real-world cause is the kit (or
    // its run context) disappearing between dispatch and Job start.
    const reason = `run context unavailable (kit deleted?): ${message}`;
    try {
      await runs.updateRunStatus(runId, "failed", { finishedAt: now(), error: reason });
    } catch {
      throw err; // could not record → UNHANDLED (exit 1)
    }
    throw new HandledRunFailureError(reason, { cause: err });
  }
}

/**
 * Executes the run identified by `RUN_ID`. Pure: throws on any failure so the
 * caller decides the exit code — HandledRunFailureError / ApprovalDeniedError
 * mean the failure WAS recorded on the run record (main() exits 0); any other
 * throw means it was not (main() exits 1). A driver-recorded "failed" terminal
 * status is likewise surfaced as HandledRunFailureError.
 */
export async function runTask(env: Env = process.env): Promise<void> {
  // Boot hardening (Q2): announce the free/BYO mode once per process when no
  // gateway is configured. Single info log, before any per-run work.
  logBootMode(env);

  const runId = requireEnv(env, "RUN_ID");
  // The web-forge internal resolve endpoint + its service key. These names match
  // the ECS task-def env injected by the CDK stack and the web app's config.
  const resolveBaseUrl = requireEnv(env, "WEB_FORGE_INTERNAL_URL");
  const resolveServiceKey = requireEnv(env, "AUTO_WORKER_SERVICE_KEY");

  // Storage + ledger + email sender are backend-keyed (AWS hosted vs Postgres
  // self-host). Phase D (hardened isolation): AUTO_WORKSPACE_DIR points per-run
  // workspaces at the writable scratch mount under a read-only root filesystem;
  // when unset both backends fall back to os.tmpdir() (backward-compatible).
  const { storage, ledger, emailSender, managed, royaltyStore } = await buildBackendDeps(env);

  // Auto v2 run fee (invocation + active-minute), in US cents. Resolved from the
  // commercial gateway overlay and gated on `managed`: the free / open-core ledger
  // (managed === false) yields 0/0 so a self-host pays nothing and the ledger is
  // never touched for fees.
  const v2Rates = await loadAutoV2Rates(managed, env);

  // Platform (managed) provider. In self-host FREE mode every run is BYO so this
  // is never exercised; it stays inert (throws) when ANTHROPIC_API_KEY is unset.
  const chatProvider = createManagedRoutingProvider();

  // Single up-front fetch of the resolve payload: it carries BOTH the kit
  // context AND the per-run inference mode / BYO provider config. We reuse the
  // same payload for the resolveKitContext hook to avoid a second round-trip.
  // On a fetch failure the run is best-effort marked FAILED first (see
  // resolveContextOrFailRun) so it never sits `queued` forever in the UI.
  const payload = await resolveContextOrFailRun({
    runId,
    baseUrl: resolveBaseUrl,
    serviceKey: resolveServiceKey,
    runs: storage.runs,
    now: () => new Date().toISOString(),
  });

  const inferenceMode: InferenceMode = payload.inferenceMode;

  // BYO provider: only when the run is BYO and the resolver returned a key. The
  // provider can be ANY supported type (anthropic/openai/openai-compatible/gemini/
  // ollama) — buildChatProvider maps (providerType, apiKey, baseUrl, model) to the
  // right adapter. A legacy payload that omits providerType defaults to anthropic.
  let byoChatProvider: ChatProvider | undefined;
  if (inferenceMode === "byo" && payload.byoProvider) {
    byoChatProvider = buildChatProvider({
      providerType: payload.byoProvider.providerType ?? "anthropic",
      apiKey: payload.byoProvider.apiKey,
      ...(payload.byoProvider.baseUrl !== undefined
        ? { baseUrl: payload.byoProvider.baseUrl }
        : {}),
      ...(payload.byoProvider.model !== undefined
        ? { model: payload.byoProvider.model }
        : {}),
    });
  }

  // Auto v2: tokens pass through AT COST (no markup). The platform margin is the
  // run-based compute charge (invocation + active-minute) resolved below. Still
  // env-overridable via AUTO_MARKUP_BPS for a deployment that wants a token margin.
  const markupBps = parseIntEnv(env, "AUTO_MARKUP_BPS", 0);

  const deps: ProcessAutoRunDeps = {
    storage,
    chatProvider,
    ...(byoChatProvider ? { byoChatProvider } : {}),
    inferenceMode,
    ledger,
    resolveKitContext: toResolveKitContext(payload),
    now: () => new Date().toISOString(),
    markupBps,
    invocationFeeCents: v2Rates.invocationFeeCents,
    activeMinuteRateCents: v2Rates.activeMinuteRateCents,
    freeActiveMinutesPerMonth: v2Rates.freeActiveMinutesPerMonth,
    // Opt-in result delivery (Phase D). The email sender is backend-specific:
    // SES (hosted, inert until SES_SENDER set) or the SMTP sender (selfhost,
    // inert until SMTP_HOST + SMTP_FROM are set). Webhook delivery uses global
    // fetch + a real DNS resolver behind the SSRF guard regardless.
    // All best-effort — a delivery failure never fails the run.
    emailSender,
    deliveryFetch: globalFetch,
    deliveryResolver: dnsResolver,
    // Durable royalty-accrual reconciliation store (M6 #5). Present only on the
    // Postgres backend; the worker records an unaccrued intent iff a premium
    // royalty was charged and its accrual threw (best-effort; never fails a run).
    ...(royaltyStore ? { royaltyStore } : {}),
    ...(env["AUTO_MAX_TOKENS"] !== undefined
      ? { maxTokens: parseIntEnv(env, "AUTO_MAX_TOKENS", 0) }
      : {}),
    ...(env["AUTO_MAX_TOOL_ROUNDS"] !== undefined
      ? { maxToolRounds: parseIntEnv(env, "AUTO_MAX_TOOL_ROUNDS", 0) }
      : {}),
  };

  const result = await processAutoRun(runId, deps);

  if (result.status === "failed") {
    // The driver RECORDED the terminal `failed` status (and settled billing)
    // before returning — this is a HANDLED failure. Throw the typed error (no
    // prompt, status only) so main() logs it and exits 0.
    throw new HandledRunFailureError(`Auto run ${runId} finished: failed`);
  }

  // Status only — never the prompt or any output.
  console.log(`Auto run ${runId} finished: ${result.status}`);
}

/**
 * Process wrapper — owns the exit-code contract (see the module header):
 *
 *   - clean return → exit 0 (terminal succeeded/canceled/budget_exceeded).
 *   - HandledRunFailureError / ApprovalDeniedError → the run's terminal
 *     `failed` status WAS recorded → log + EXIT 0, so the k8s Job reads
 *     Complete and the operator's KubeJobFailed alert only fires for real
 *     worker crashes. (ApprovalDeniedError is only ever thrown AFTER the
 *     `failed` write succeeded — see denyAndFail in worker.ts.)
 *   - anything else → the outcome may be unrecorded → exit 1.
 *
 * `runTaskImpl` is injectable for tests; production uses `runTask`.
 */
export async function main(runTaskImpl: () => Promise<void> = runTask): Promise<void> {
  try {
    await runTaskImpl();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof HandledRunFailureError || err instanceof ApprovalDeniedError) {
      console.error(`Auto run failed (handled — run record updated): ${message}`);
      return; // exit 0
    }
    console.error(`Auto run failed: ${message}`);
    process.exit(1);
  }
}

// Standard ESM entry guard: only run when invoked directly (the task main),
// not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
