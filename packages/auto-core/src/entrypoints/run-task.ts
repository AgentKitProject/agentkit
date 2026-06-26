/**
 * run-task — the Fargate task main for AgentKitAuto.
 *
 * ECS launches one task per run, passing `RUN_ID` in the environment. This
 * entrypoint wires the AWS-backed storage (via the task role — no static keys),
 * the platform Anthropic provider + credit ledger, and an HTTP-backed kit-context
 * resolver, then executes the run end-to-end via `processAutoRun`.
 *
 * `runTask` is kept PURE (it throws on failure rather than calling
 * `process.exit`), so it stays unit-testable. `main()` is the process wrapper:
 * it catches and maps any rejection (or a "failed" terminal status) to a
 * non-zero exit so ECS marks the task failed.
 *
 * Security: NEVER log the system prompt, kit context, or a BYO API key. On
 * success we log only the run id + terminal status.
 */

import {
  AnthropicChatProvider,
  createManagedAnthropicProvider,
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
  type PgPool,
} from "../adapters/selfhost/postgres.js";
import { makeSelfHostEmailSender } from "../adapters/selfhost/email-sender.js";
import { makeFreeCreditLedger } from "../adapters/selfhost/free-ledger.js";
import type { DnsResolver, FetchFn } from "../core/http-fetch.js";
import {
  fetchResolveContext,
  toResolveKitContext,
} from "../core/http-resolve-context.js";
import { processAutoRun, type ProcessAutoRunDeps } from "./worker.js";

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
    // "managed" billing (the Postgres credit ledger) is a COMMERCIAL feature in
    // @agentkit-commercial/gateway, optionally loaded at runtime (mirrors
    // auto.ts `selectLedger()` / market-core `loadCommercial()`). The credit
    // ledger is OWNED BY THE GATEWAY SERVICE and lives in ITS database
    // (agentkitgateway) — NOT the auto app DB — so Stripe top-ups (gateway) and
    // run debits (this worker) hit the SAME balance. Connect a SEPARATE pool to
    // GATEWAY_DATABASE_URL for it; the gateway pod owns/applies the ledger schema.
    // When GATEWAY_DATABASE_URL or the commercial package is absent, degrade to
    // the inert FREE ledger so the open-core path runs unmetered.
    const billing = (env["AUTO_SELFHOST_BILLING"] || "free").toLowerCase();
    const gatewayDbUrl = env["GATEWAY_DATABASE_URL"];
    let ledger: CreditLedgerRepository;
    let managed = false;
    if (billing === "managed" && gatewayDbUrl && gatewayDbUrl.trim() !== "") {
      const gatewayPool = new Pool({
        connectionString: gatewayDbUrl,
      }) as unknown as PgPool;
      // loadManagedLedger degrades to the FREE ledger when the commercial package
      // is absent; `managed` reflects whether the metered ledger actually loaded.
      ({ ledger, managed } = await loadManagedLedgerWithFlag(gatewayPool));
    } else {
      ledger = makeFreeCreditLedger();
    }
    // SMTP email sender: active when SMTP_HOST + SMTP_FROM are set in env;
    // inert (skipped) otherwise — webhook delivery still works regardless.
    return { storage, ledger, emailSender: makeSelfHostEmailSender(), managed };
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

/**
 * The optional commercial gateway overlay surface this worker consumes. Only the
 * `createPostgresCreditLedger` factory is needed here (the schema is applied by
 * the web app / gateway composition root, and `ensureAutoSchema` already runs
 * for the Auto tables). Kept as a narrow local type so the worker doesn't take a
 * hard dependency on the private package's types.
 */
interface CommercialGatewayModule {
  createPostgresCreditLedger(pool: PgPool): CreditLedgerRepository;
  /**
   * Auto v2 run-based pricing (commercial moat): the flat invocation fee + the
   * per-active-minute rate, in US cents, plus the per-user monthly FREE
   * active-minute allowance (Slice 2). Absent in the public build → the worker
   * defaults to 0 fees / 0 free minutes (no v2 fee, un-metered).
   */
  getAutoV2Pricing?: () => {
    invocationFeeCents: number;
    activeMinuteRateCents: number;
    freeActiveMinutesPerMonth?: number;
  };
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

/** Importer seam so tests can inject a fake / force the absent path. */
type CommercialImporter = () => Promise<CommercialGatewayModule>;

const defaultCommercialImporter: CommercialImporter = () =>
  // The private package is ABSENT in the public / self-host build, so this
  // dynamic import fails there; the caller's try/catch degrades to the free
  // ledger. The hosted DOKS image installs @agentkit-commercial/gateway, so the
  // import resolves and the managed Postgres credit ledger is wired in.
  import("@agentkit-commercial/gateway") as Promise<CommercialGatewayModule>;

/**
 * Optionally loads the commercial managed Postgres credit ledger over the
 * worker's pool. Present (hosted) → the metered Postgres ledger; absent
 * (public / self-host) → the inert FREE ledger (never debits). Mirrors
 * `selectLedger()` in apps/auto-web/server/core/auto.ts and
 * `loadCommercial()` in market-core's server entrypoint.
 */
export async function loadManagedLedger(
  pool: PgPool,
  importer: CommercialImporter = defaultCommercialImporter,
): Promise<CreditLedgerRepository> {
  return (await loadManagedLedgerWithFlag(pool, importer)).ledger;
}

/**
 * Like `loadManagedLedger`, but also reports whether the COMMERCIAL managed
 * ledger actually loaded (`managed: true`) vs degrading to the inert FREE ledger
 * (`managed: false`). The `managed` flag gates the Auto v2 run fee so a free
 * deployment never applies it.
 */
export async function loadManagedLedgerWithFlag(
  pool: PgPool,
  importer: CommercialImporter = defaultCommercialImporter,
): Promise<{ ledger: CreditLedgerRepository; managed: boolean }> {
  try {
    const mod = await importer();
    return { ledger: mod.createPostgresCreditLedger(pool), managed: true };
  } catch {
    // Commercial package absent (public / self-host) → free ledger (never debits).
    return { ledger: makeFreeCreditLedger(), managed: false };
  }
}

/**
 * Resolves the Auto v2 run-fee rates (invocation + active-minute) from the
 * commercial gateway overlay. Present (hosted) → the moat rates; absent (public /
 * self-host) OR `enabled === false` → 0/0 (no v2 fee). The `enabled` gate is the
 * managed-vs-free decision: even if the commercial package is importable, a free
 * deployment must pay nothing, so the caller passes `enabled: deps.managed`.
 *
 * Env overrides (operator/test escape hatch): AUTO_INVOCATION_FEE_CENTS,
 * AUTO_ACTIVE_MINUTE_RATE_CENTS, and AUTO_FREE_ACTIVE_MINUTES_PER_MONTH take
 * precedence over the commercial defaults.
 */
export async function loadAutoV2Rates(
  enabled: boolean,
  env: Env = process.env,
  importer: CommercialImporter = defaultCommercialImporter,
): Promise<AutoV2Rates> {
  if (!enabled) {
    return { invocationFeeCents: 0, activeMinuteRateCents: 0, freeActiveMinutesPerMonth: 0 };
  }

  let invocationFeeCents = 0;
  let activeMinuteRateCents = 0;
  let freeActiveMinutesPerMonth = 0;
  try {
    const mod = await importer();
    const pricing = mod.getAutoV2Pricing?.();
    if (pricing) {
      invocationFeeCents = Math.max(0, pricing.invocationFeeCents);
      activeMinuteRateCents = Math.max(0, pricing.activeMinuteRateCents);
      // Free allowance is optional on the module shape (older overlays may omit
      // it); default to 0 (no free tier) when absent.
      freeActiveMinutesPerMonth = Math.max(0, pricing.freeActiveMinutesPerMonth ?? 0);
    }
  } catch {
    // Commercial package absent → 0/0/0 (defensive; `enabled` should already be
    // false on the public build, but never charge if the moat numbers are gone).
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
 * Executes the run identified by `RUN_ID`. Pure: throws on any failure (missing
 * env, denied approval, or a "failed" terminal status) so the caller decides
 * the exit code.
 */
export async function runTask(env: Env = process.env): Promise<void> {
  const runId = requireEnv(env, "RUN_ID");
  // The web-forge internal resolve endpoint + its service key. These names match
  // the ECS task-def env injected by the CDK stack and the web app's config.
  const resolveBaseUrl = requireEnv(env, "WEB_FORGE_INTERNAL_URL");
  const resolveServiceKey = requireEnv(env, "AUTO_WORKER_SERVICE_KEY");

  // Storage + ledger + email sender are backend-keyed (AWS hosted vs Postgres
  // self-host). Phase D (hardened isolation): AUTO_WORKSPACE_DIR points per-run
  // workspaces at the writable scratch mount under a read-only root filesystem;
  // when unset both backends fall back to os.tmpdir() (backward-compatible).
  const { storage, ledger, emailSender, managed } = await buildBackendDeps(env);

  // Auto v2 run fee (invocation + active-minute), in US cents. Resolved from the
  // commercial gateway overlay and gated on `managed`: the free / open-core ledger
  // (managed === false) yields 0/0 so a self-host pays nothing and the ledger is
  // never touched for fees.
  const v2Rates = await loadAutoV2Rates(managed, env);

  // Platform (managed) provider. In self-host FREE mode every run is BYO so this
  // is never exercised; it stays inert (throws) when ANTHROPIC_API_KEY is unset.
  const chatProvider = createManagedAnthropicProvider();

  // Single up-front fetch of the resolve payload: it carries BOTH the kit
  // context AND the per-run inference mode / BYO provider config. We reuse the
  // same payload for the resolveKitContext hook to avoid a second round-trip.
  const payload = await fetchResolveContext({
    runId,
    baseUrl: resolveBaseUrl,
    serviceKey: resolveServiceKey,
  });

  const inferenceMode: InferenceMode = payload.inferenceMode;

  // BYO provider: only when the run is BYO and the resolver returned a key.
  let byoChatProvider: ChatProvider | undefined;
  if (inferenceMode === "byo" && payload.byoProvider) {
    byoChatProvider = new AnthropicChatProvider({
      apiKey: payload.byoProvider.apiKey,
      ...(payload.byoProvider.baseUrl !== undefined
        ? { baseUrl: payload.byoProvider.baseUrl }
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
    ...(env["AUTO_MAX_TOKENS"] !== undefined
      ? { maxTokens: parseIntEnv(env, "AUTO_MAX_TOKENS", 0) }
      : {}),
    ...(env["AUTO_MAX_TOOL_ROUNDS"] !== undefined
      ? { maxToolRounds: parseIntEnv(env, "AUTO_MAX_TOOL_ROUNDS", 0) }
      : {}),
  };

  const result = await processAutoRun(runId, deps);

  if (result.status === "failed") {
    // Throw (no prompt) so main() maps it to a non-zero exit.
    throw new Error(`Auto run ${runId} finished: failed`);
  }

  // Status only — never the prompt or any output.
  console.log(`Auto run ${runId} finished: ${result.status}`);
}

/** Process wrapper: run, then exit non-zero on any rejection. */
export async function main(): Promise<void> {
  try {
    await runTask();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Auto run failed: ${message}`);
    process.exit(1);
  }
}

// Standard ESM entry guard: only run when invoked directly (the task main),
// not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
