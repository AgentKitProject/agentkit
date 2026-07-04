/**
 * The autonomous run-driver: drives a kit to completion with NO human in the
 * per-step loop.
 *
 * ENGINE REUSE: this composes @agentkitforge/gateway-core directly. In MANAGED
 * mode each model turn goes through `runManagedTurn`, which performs the
 * two-phase credit hold, makes the provider call with the platform key, and
 * settles the ACTUAL metered cost (with markup) via `computeDebitCents` — Auto
 * does NOT re-implement the chat call, pricing, or billing. The driver only owns
 * the AUTONOMOUS loop (multi-turn tool execution without a confirm dialog) plus
 * the Auto-specific guards: a per-run budget cap and a kill-switch.
 *
 * BILLING MODEL (server-chosen by code path, never client-supplied):
 *   - inferenceMode "managed": platform provider + prepaid credits. Inference is
 *     debited at `markupBps` (Auto's own configured markup; 0 by default) per turn.
 *     This is today's path.
 *   - inferenceMode "byo": the caller-supplied BYO ChatProvider (user's key) is
 *     called DIRECTLY — the credit ledger is NOT touched for inference (the user
 *     is billed by their provider). spentInferenceCents stays 0.
 *
 * AUTO v2 RUN FEE (invocation + active-minute): the platform margin moved off
 * per-token markup (now 0 — tokens pass through at cost) onto a RUN-based compute
 * charge that applies to EVERY hosted run, managed OR BYO:
 *   - a flat INVOCATION fee, debited ONCE at run start (invocationFeeCents), and
 *   - a per-ACTIVE-MINUTE fee, ceil(wall-clock minutes) * activeMinuteRateCents,
 *     settled at completion / cancel / failure / budget-stop.
 * The active-minute mechanism is the generalization of the old cloud-run compute
 * fee (same reserveHold/settleHold pattern on the SAME CreditLedgerRepository).
 * The run reserves an up-front hold covering invocation + the budget-derived
 * estimated active-minutes (estimatedMin = ceil(budgetCents / rate), which also
 * caps the run's wall-clock), settles the ACTUAL invocation + ceil(actualMin) *
 * rate, and releases the overshoot.
 *
 * OPEN-CORE / SELF-HOST SAFETY: both rates default to 0. They are only non-zero
 * when the consumer (run-task) resolves them from the private
 * @agentkit-commercial/gateway package on the HOSTED managed path. With the
 * commercial package absent (public build) or the FREE self-host ledger, the
 * rates are 0 and the entire v2-fee path is skipped — the ledger is never
 * touched, so a self-host pays nothing.
 *
 * Per turn:
 *   1. before the turn — check spentInferenceCents < budgetCents (else
 *      budget_exceeded); check isCancelRequested (else canceled); for cloud BYO
 *      runs, also stop once the metered minutes reach the budget-derived cap.
 *   2. run the turn (managed: runManagedTurn; byo: chatProvider.sendMessage).
 *   3. recordSpend(debitedCents) → new spentInferenceCents; if it reaches the
 *      budget, stop after this turn with budget_exceeded.
 *   4. if the model emitted tool_use → run each through the sandbox executor,
 *      append the results, and loop. Otherwise the run is complete → succeeded.
 *
 * maxToolRounds bounds the loop. Any thrown error → failed.
 *
 * NO-QUESTIONS PREAMBLE (Auto v2 Slice 4): Auto is fully autonomous — there is NO
 * human available mid-run to answer questions (the approval is a PRE-run gate). A
 * run that ends its turn with a question is FINE (end_turn completes the run,
 * bills elapsed-only, frees the worker), but a kit that stops to "ask" instead of
 * proceeding wastes the run. So EVERY Auto run gets a short, firm instruction
 * prepended to its system prompt telling the agent to make reasonable assumptions
 * and run to completion rather than ask. This is a behavior guarantee for ALL
 * runs (managed + BYO + self-host) — it lives in public auto-core, not the
 * commercial package, and is the single source of truth (AUTO_NO_QUESTIONS_PREAMBLE).
 */

import {
  runManagedTurn,
  FREE_TRIAL_PERIOD_KEY,
  type ChatProvider,
  type CreditLedgerRepository,
  type ChatRequest,
  type ChatResponse,
  type ConversationMessage,
  type ContentBlock,
  type ToolDefinition,
  type ToolUseBlock,
} from "@agentkitforge/gateway-core";

import type { AutoApproval, AutoRun, AutoRunResult, InferenceMode } from "./types.js";
import type { AutoRunRepository, WorkspaceStore } from "./ports.js";
import type { SandboxExecutor } from "./sandbox-executor.js";
import { identityRedactor, type OutputRedactor } from "./leakage-guard.js";

/** The terminal outcome of an autonomous run. */
export interface RunAutoRunResult {
  status: "succeeded" | "failed" | "canceled" | "budget_exceeded";
  result?: AutoRunResult;
  error?: string;
  /** Total cents debited for this run (inference + invocation + active-minutes). */
  spentCents: number;
  /** Cents debited for model inference only (0 in BYO mode). */
  spentInferenceCents: number;
  /**
   * Cents debited for the Auto v2 run compute fee: the flat invocation fee plus
   * the per-active-minute fee. 0 when the v2 rates are disabled (open-core /
   * self-host FREE). Persisted into the run's `spentComputeCents` column.
   */
  spentComputeCents: number;
  /** Cents debited for the flat invocation fee alone (subset of compute). */
  spentInvocationCents: number;
  /** Cents debited for the active-minute fee alone (subset of compute). */
  spentActiveMinuteCents: number;
  /**
   * Cents debited from the BUYER for the PREMIUM (per-invocation) kit royalty on
   * this run (0 unless a premium royalty > 0 and the run reached a BILLABLE
   * terminal state). This is the same gross the seller accrues against; it is
   * NOT part of spentComputeCents (compute = invocation + active-minute), it is
   * a separate line for the receipt. 0 on a FAILED run and on every open-core /
   * self-host / non-premium run.
   */
  spentRoyaltyCents: number;
  /**
   * Whether the seller royalty for this run was accrued. true when a royalty was
   * charged AND the accrual succeeded, OR when no royalty applied (nothing owed).
   * false ONLY when the buyer was charged a royalty (spentRoyaltyCents > 0) but the
   * accrual threw — the worker uses this to durably queue the run for the M6
   * royalty-reconciliation job. Always true on open-core / self-host / non-premium.
   */
  royaltyAccrued: boolean;
  /** Number of tool-execution rounds driven. */
  toolRounds: number;
}

export interface RunAutoRunDeps {
  /**
   * Provider used for inference. In managed mode this is the PLATFORM (managed)
   * key provider from gateway-core; in BYO mode this is the caller-supplied
   * provider configured with the USER's own key.
   */
  chatProvider: ChatProvider;
  /** The credit ledger backing this deployment — from gateway-core. */
  ledger: CreditLedgerRepository;
  /** Auto run repository (lifecycle, spend, cancel-switch). */
  runs: AutoRunRepository;
  /** The run's workspace, used to bundle the final file manifest. */
  workspace: WorkspaceStore;
  /** Clock — ISO 8601. Also used to meter wall-clock minutes for cloud runs. */
  now: () => string;
  /**
   * Inference billing mode. "managed" (default) debits the ledger per turn at
   * markupBps; "byo" calls chatProvider directly and never debits inference.
   */
  inferenceMode?: InferenceMode;
  /** Markup in bps; forwarded to runManagedTurn (managed mode only). */
  markupBps?: number;
  /** Per-turn max output tokens. Default 4096. */
  maxTokens?: number;
  /**
   * Auto v2 flat invocation fee in US cents, debited ONCE at run start. Default
   * 0 (disabled) — non-zero only on the HOSTED managed path where run-task
   * resolves it from @agentkit-commercial/gateway. 0 → no invocation debit.
   */
  invocationFeeCents?: number;
  /**
   * Auto v2 per-active-minute fee in US cents (run start → completion wall-clock).
   * Default 0 (disabled) — non-zero only on the HOSTED managed path. 0 → no
   * active-minute debit. Applies to ALL runs (managed AND BYO) when non-zero.
   */
  activeMinuteRateCents?: number;
  /**
   * Auto ONE-TIME free trial of active-minutes per user (LIFETIME — no monthly
   * reset; the historical "PerMonth" name is kept for wire/dep compatibility).
   * While any trial minutes remain: the active-minute fee is waived for those
   * minutes, the INVOCATION fee is waived entirely, and the up-front hold is
   * grace-shrunk — a $0-balance user can genuinely consume the trial. Default
   * 0 (no trial) — non-zero only on the HOSTED managed path where run-task
   * resolves it from @agentkit-commercial/gateway. Depletion is tracked under
   * the fixed FREE_TRIAL_PERIOD_KEY ledger row and is idempotent per run.
   */
  freeActiveMinutesPerMonth?: number;
  /**
   * PREMIUM (per-invocation) kit royalty for THIS run, in US cents (M6). The
   * seller-set per-run price, metered from the BUYER's prepaid balance and
   * accrued to the SELLING org. Default 0 (disabled) — non-zero only for a
   * premium kit on the hosted managed path where run-task resolves it from the
   * kit's pricing + the resolve-context seam. 0 → the entire royalty path is
   * SKIPPED and the run behaves byte-for-byte as today (open-core / self-host /
   * free / non-premium runs are unaffected).
   */
  premiumRoyaltyCents?: number;
  /** The SELLING org that earns the royalty. Required (non-empty) when
   *  premiumRoyaltyCents > 0; ignored otherwise. */
  royaltyOrgId?: string;
  /** The premium kit that was run. Required (non-empty) when
   *  premiumRoyaltyCents > 0; ignored otherwise. */
  royaltyKitId?: string;
  /**
   * Platform commission in basis points withheld from the royalty at accrual
   * (0 → the seller keeps 100%, the self-host default). Non-zero only on the
   * hosted path via the resolve-context seam. Passed straight to the ledger's
   * accrueRoyalty; never a hardcoded rate here.
   */
  royaltyCommissionBps?: number;
  /**
   * GOVERNANCE ACCOUNTING (org budgets v2) — best-effort, open-core-safe. When
   * provided, called ONCE at run finalize (every terminal status) with the run's
   * final spend (inference + compute cents) and elapsed active-minutes, keyed by
   * user + UTC `YYYY-MM` period. The consumer (auto-web) forwards this to the
   * Profile usage seam so an org's monthly usage rolls up. Default undefined → a
   * NO-OP: open-core / self-host runs don't depend on any usage service. It must
   * never throw and never affect the run result (the call is awaited under a
   * swallowing `.catch`).
   */
  recordOrgUsage?: (info: {
    userId: string;
    period: string;
    cents: number;
    minutes: number;
  }) => Promise<void>;
}

export interface RunAutoRunArgs {
  run: AutoRun;
  approval: AutoApproval;
  /** Rendered kit context / system prompt injected as the system message. */
  systemPrompt?: string;
  kitContext?: string;
  /** Tools advertised to the model (Anthropic tool-definition shape). */
  tools: ToolDefinition[];
  /** The sandbox executor (the hands). */
  executeTool: SandboxExecutor;
  deps: RunAutoRunDeps;
  /** Safety bound on tool rounds. Default 64. */
  maxToolRounds?: number;
  /**
   * PROTECTED-KIT OUTPUT REDACTOR (M6 content protection). When present, the run's
   * output text AND every workspace file's contents are passed through this before
   * the result is persisted / returned / delivered, masking any verbatim leak of
   * the protected kit's system prompt. Default (absent) → identity (no-op), so
   * non-protected / open-core / self-host runs are byte-for-byte unaffected. This
   * is the ONLY place the result is built, so redacting here covers all three leak
   * sinks: the stored run result, the worker's delivery, and the file manifest.
   * Best-effort deterrent only (see leakage-guard.ts).
   */
  redactOutput?: OutputRedactor;
}

/**
 * The no-questions preamble prepended to EVERY Auto run's system prompt (Auto v2
 * Slice 4). Auto runs are fully autonomous with no human in the loop, so the
 * agent must not stall waiting for clarification — it makes the most reasonable
 * assumption and runs to completion. Single source of truth; applies to every run
 * regardless of kit, billing mode, or deployment (managed / BYO / self-host).
 */
export const AUTO_NO_QUESTIONS_PREAMBLE =
  "You are running autonomously with no human available to answer questions. " +
  "Do not ask the user questions or request clarification. Proceed with the " +
  "information given; if something is ambiguous or missing, make the most " +
  "reasonable assumption, state it briefly, and continue to completion.";

/**
 * Composes the run's system prompt: the no-questions preamble (always) followed
 * by the kit's own system prompt / context (when present). Blank-separated so the
 * preamble reads as its own paragraph. With no kit prompt, the preamble alone is
 * the system message.
 */
export function composeSystemPrompt(kitSystem: string): string {
  return kitSystem ? `${AUTO_NO_QUESTIONS_PREAMBLE}\n\n${kitSystem}` : AUTO_NO_QUESTIONS_PREAMBLE;
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function toolUsesOf(content: ContentBlock[]): ToolUseBlock[] {
  return content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

/** Wall-clock minutes elapsed between two ISO timestamps (>= 0). */
function elapsedMinutes(startIso: string, endIso: string): number {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return ms / 60_000;
}

/**
 * The UTC calendar-month key ("YYYY-MM") for an ISO timestamp — used for
 * MONTHLY aggregations (org usage periods). The free trial does NOT use it:
 * trial reads/depletions use the fixed lifetime FREE_TRIAL_PERIOD_KEY (the
 * 60 minutes are a ONE-TIME trial, never reset — maintainer 2026-07-03).
 */
function utcYearMonth(iso: string): string {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Runs a kit autonomously to completion. Returns the terminal outcome; also
 * persists status, spend, result, and audit through the injected repo so the
 * worker/entrypoint can stay thin.
 */
export async function runAutoRun(args: RunAutoRunArgs): Promise<RunAutoRunResult> {
  const { run, tools, executeTool, deps } = args;
  const { chatProvider, ledger, runs, workspace, now } = deps;
  const maxToolRounds = args.maxToolRounds ?? 64;
  // Protected-kit output redactor (M6). Identity for every non-protected run, so
  // those are byte-for-byte unaffected. `isRedacting` gates the (more expensive)
  // per-file content rewrite so we only touch the workspace when there's a secret
  // to protect.
  const redactOutput: OutputRedactor = args.redactOutput ?? identityRedactor;
  const isRedacting = args.redactOutput !== undefined;
  const maxTokens = deps.maxTokens ?? 4096;
  // Always prepend the no-questions preamble so every Auto run is told to proceed
  // autonomously rather than stop to ask (Auto v2 Slice 4). Applies to managed +
  // BYO + self-host alike.
  const system = composeSystemPrompt(args.systemPrompt ?? args.kitContext ?? "");

  const inferenceMode: InferenceMode =
    deps.inferenceMode ?? run.inferenceMode ?? "managed";

  // Workspace id resolved from the run; the worker creates it before this call.
  const workspaceId = run.workspaceId;
  if (!workspaceId) {
    throw new Error("runAutoRun requires run.workspaceId to be set by the worker.");
  }

  // Inference spend is the budget-gated quantity. (In BYO mode it stays 0 — the
  // budget then only bounds the active-minute fee below.)
  let spentInferenceCents = run.spentCents;
  let spentInvocationCents = 0;
  let spentActiveMinuteCents = 0;
  let spentRoyaltyCents = 0;
  // Whether the seller royalty for this run was successfully accrued. Starts true
  // (nothing owed / non-premium); set false ONLY when the buyer WAS charged a
  // royalty but the immediate accrual threw — the signal the worker uses to
  // durably record an unaccrued-royalty intent for the reconciliation job (M6 #5).
  let royaltyAccrued = true;
  const budgetCents = run.budgetCents;

  // ---- Auto v2 run compute fee (invocation + active-minute) -----------------
  // Generalizes the old per-minute cloud-run fee: applies to ALL runs (managed
  // AND BYO) at the v2 rates. Both rates default to 0 (open-core / self-host
  // FREE), in which case the entire fee path is skipped and the ledger is never
  // touched. The rates are non-zero only on the hosted managed path, where
  // run-task resolves them from @agentkit-commercial/gateway.
  const invocationFeeCents = Math.max(0, deps.invocationFeeCents ?? 0);
  const activeMinuteRateCents = Math.max(0, deps.activeMinuteRateCents ?? 0);
  // Auto v2 Slice 2 → ONE-TIME FREE TRIAL (maintainer 2026-07-03): the free
  // active-minutes are a LIFETIME trial (fixed ledger key, NO monthly reset;
  // the field name keeps its historical "PerMonth" spelling for wire/dep
  // compatibility). 0 → no trial. While any trial minutes remain the
  // INVOCATION fee is ALSO waived and the up-front hold shrinks by the
  // remaining allowance, so a $0-balance user can genuinely consume the trial
  // (aligns with gateway-core checkAffordability's zero-balance admission).
  const freeActiveMinutesPerMonth = Math.max(0, deps.freeActiveMinutesPerMonth ?? 0);

  // ---- PREMIUM (per-invocation) kit royalty (M6) ----------------------------
  // The seller-set per-run price, metered from the BUYER's balance and accrued to
  // the SELLING org. Defaults 0 → the whole path is inert (open-core / self-host /
  // free / non-premium runs behave byte-for-byte as today). Gated additionally on
  // a resolved org + kit so a misconfigured caller can never accrue to an empty
  // org — it just falls inert. commissionBps defaults 0 (seller keeps 100%).
  const premiumRoyaltyCents = Math.max(0, deps.premiumRoyaltyCents ?? 0);
  const royaltyOrgId = deps.royaltyOrgId ?? "";
  const royaltyKitId = deps.royaltyKitId ?? "";
  const royaltyCommissionBps = Math.max(0, deps.royaltyCommissionBps ?? 0);
  const chargeRoyalty =
    premiumRoyaltyCents > 0 && royaltyOrgId !== "" && royaltyKitId !== "";

  // The run reserves the v2 hold (invocation + active-minute) AND — when a
  // premium royalty applies — the royalty on top, since both settle from the SAME
  // buyer hold. With chargeRoyalty false this is identical to the v2-only path.
  const chargeRunFee = invocationFeeCents > 0 || activeMinuteRateCents > 0 || chargeRoyalty;
  // Budget-derived cap on active minutes (also caps the run's wall-clock). When
  // the active-minute rate is 0 there is no minute-derived cap (only the
  // invocation fee applies). ceil so a partial budget still funds a whole minute.
  const estimatedMin =
    activeMinuteRateCents > 0 ? Math.ceil(budgetCents / activeMinuteRateCents) : 0;
  const startedAtIso = now();
  let runFeeHoldId: string | undefined;
  let runFeeHoldCents = 0;
  let runFeeSettled = false;

  /** Settle the v2 ACTIVE-MINUTE fee AND — on a BILLABLE terminal state only —
   *  the PREMIUM (per-invocation) royalty, from the SAME up-front hold (idempotent
   *  — runs once): the hold is settled with ceil(actual active minutes) * rate +
   *  (billable ? royalty : 0), capped by the reserved hold, releasing the
   *  overshoot. The invocation fee is a separate up-front debit and is NOT part of
   *  this settle. On a non-billable ('failed') terminal state the royalty is NOT
   *  settled and NOT accrued — it rides the hold release. Folds the settled fees
   *  into the run's persisted total spend, and accrues the seller royalty on a
   *  billable settle.
   *
   *  @param billable  true for a BILLABLE terminal state (succeeded |
   *                   budget_exceeded | canceled); false for 'failed'. Governs
   *                   whether the royalty is charged + accrued. */
  const settleActiveMinutes = async (billable: boolean): Promise<void> => {
    // Guarded by a flag, NOT the hold id: with a grace-shrunk (possibly zero)
    // hold the metering below must still run — it is what depletes the monthly
    // free allowance. Skipping it would make the free tier infinite.
    if (runFeeSettled || !chargeRunFee) return;
    runFeeSettled = true;
    const holdId = runFeeHoldId;
    runFeeHoldId = undefined;
    let minutes = elapsedMinutes(startedAtIso, now());
    if (estimatedMin > 0) minutes = Math.min(minutes, estimatedMin);
    // Whole active-minutes this run consumed (the billing unit). ceil so any
    // partial minute counts as a full one — matches the up-front hold estimate.
    const runActiveMinutes = activeMinuteRateCents > 0 ? Math.ceil(minutes) : 0;

    // Auto v2 Slice 2: apply the per-user monthly FREE active-minute allowance.
    // consumeFreeActiveMinutes atomically computes how many of this run's
    // active-minutes fall OUTSIDE the remaining free allowance (billableMinutes)
    // and depletes the month's usage by runActiveMinutes — IDEMPOTENTLY per
    // run.id, so a re-settle / retry neither double-charges nor double-depletes.
    // With freeActiveMinutesPerMonth === 0 (no free tier) every minute is
    // billable; the FREE self-host ledger returns 0 billable (un-metered).
    let billableMinutes = runActiveMinutes;
    if (runActiveMinutes > 0) {
      billableMinutes = await ledger.consumeFreeActiveMinutes(
        run.userId,
        FREE_TRIAL_PERIOD_KEY,
        runActiveMinutes,
        freeActiveMinutesPerMonth,
        run.id,
      );
    }
    const activeMinuteCents =
      activeMinuteRateCents > 0 ? billableMinutes * activeMinuteRateCents : 0;
    // The premium royalty is charged from the buyer ONLY on a BILLABLE terminal
    // state. On 'failed' it is 0 → it rides the hold release below (never debited,
    // never accrued to the seller).
    const royaltyCharged = chargeRoyalty && billable ? premiumRoyaltyCents : 0;

    // Settle within the hold (settleHold requires actual <= reserved). The hold
    // covered activeMinute + royalty, so settle the sum (capped at the reserved
    // hold). Only the ACTIVE-MINUTE overshoot is recovered via a direct debit
    // (the grace-shrunk-hold concurrent-depletion race); the royalty is NEVER
    // charged beyond the hold — a run that can't cover its own royalty simply
    // settles less, it does not get a surprise extra debit.
    const settleCents =
      holdId !== undefined
        ? Math.min(activeMinuteCents + royaltyCharged, runFeeHoldCents)
        : 0;
    if (holdId !== undefined) {
      await ledger.settleHold(holdId, settleCents, now(), `auto-active-${run.id}`);
    }
    // The royalty portion actually taken from the buyer within this settle. The
    // hold is always sized to cover the full estimate + royalty (royalty is a
    // fixed cent amount, not minute-derived), so on the normal path this equals
    // royaltyCharged; it only shrinks if the hold itself was under-reserved.
    const royaltyChargedActual = Math.min(royaltyCharged, settleCents);
    // Active-minute cents settled within the hold (the remainder after royalty).
    const activeSettledCents = settleCents - royaltyChargedActual;
    let chargedActiveCents = activeSettledCents;
    // Active-minute overshoot beyond the hold (grace-shrunk-hold race) — debited
    // directly, idempotent via sourceRef, best-effort. Royalty is excluded.
    const excessCents = activeMinuteCents - activeSettledCents;
    if (excessCents > 0) {
      try {
        await ledger.debit(
          run.userId,
          excessCents,
          now(),
          "Auto run active-minutes (beyond hold)",
          `auto-active-extra-${run.id}`,
        );
        chargedActiveCents += excessCents;
      } catch {
        /* best-effort — see above */
      }
    }
    spentActiveMinuteCents = chargedActiveCents;
    spentRoyaltyCents = royaltyChargedActual;
    const totalCharged = chargedActiveCents + royaltyChargedActual;
    if (totalCharged > 0) await runs.recordSpend(run.id, totalCharged);

    // Accrue the seller royalty ONLY after a billable settle actually charged the
    // buyer. IDEMPOTENT by runId (source_ref `royalty-${runId}`), so a retried run
    // accrues once. Best-effort: if accrual throws, catch+log — the buyer settle
    // above MUST NOT roll back and we do NOT double-charge (a reconciliation job
    // covers any accrual drift).
    if (royaltyChargedActual > 0) {
      try {
        await ledger.accrueRoyalty({
          orgId: royaltyOrgId,
          kitId: royaltyKitId,
          runId: run.id,
          grossRoyaltyCents: premiumRoyaltyCents,
          commissionBps: royaltyCommissionBps,
          now: now(),
        });
      } catch (err) {
        // Buyer already settled; the accrual failed. Flag it so the worker durably
        // records an unaccrued-royalty intent that the reconciliation job re-drives
        // (idempotent by runId) — this is the "reconciliation will cover" promise,
        // now backed by a real durable retry (M6 #5).
        royaltyAccrued = false;
        // eslint-disable-next-line no-console
        console.error(
          `[auto-core] royalty accrual failed for run ${run.id} (buyer already settled; queued for reconciliation): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  };

  // Seed the conversation with the user's task.
  const messages: ConversationMessage[] = [
    { role: "user", content: [{ type: "text", text: run.input.prompt }] },
  ];

  let lastText = "";
  let toolRounds = 0;

  const finalize = async (
    status: RunAutoRunResult["status"],
    extra: { error?: string } = {},
  ): Promise<RunAutoRunResult> => {
    // BILLABLE terminal state: succeeded | budget_exceeded | canceled. 'failed'
    // is NON-billable — the premium royalty is neither debited from the buyer nor
    // accrued to the seller on a failed run (it rides the hold release). This is
    // the single guarantee point for "no royalty on failure".
    const billable = status !== "failed";

    // Settle the v2 active-minute hold on ANY terminal outcome (completion,
    // cancel, failure, budget). Best-effort so a ledger hiccup can't mask the
    // run's real terminal status. (The invocation fee was already debited at run
    // start.) The premium royalty is settled + accrued INSIDE this call, but only
    // when `billable`.
    await settleActiveMinutes(billable).catch(() => {});

    // spentComputeCents = the full v2 run fee (invocation + active-minutes); it
    // is what the run's spent_compute_cents column persists.
    const spentComputeCents = spentInvocationCents + spentActiveMinuteCents;

    // GOVERNANCE ACCOUNTING (org budgets v2) — best-effort, fires on EVERY terminal
    // status. Reports the run's FINAL spend (inference + compute) and elapsed
    // active-minutes to the (optional) usage recorder so an org's monthly usage
    // rolls up. Default-absent → no-op (open-core / self-host). Swallows all errors
    // and is awaited so a slow recorder doesn't outlive the run, but it can NEVER
    // throw or change the run's terminal result.
    await deps.recordOrgUsage?.({
      userId: run.userId,
      period: utcYearMonth(startedAtIso),
      cents: spentInferenceCents + spentComputeCents,
      minutes: elapsedMinutes(startedAtIso, now()),
    }).catch(() => {});

    let result: AutoRunResult | undefined;
    if (status === "succeeded" || status === "budget_exceeded" || status === "canceled") {
      // PROTECTED-KIT WORKSPACE REDACTION (M6). Before bundling the manifest,
      // rewrite each workspace file with its contents passed through the redactor,
      // so a prompt the model wrote into a file is masked AT THE SOURCE (the
      // ephemeral workspace is the only place those contents live; rewriting here
      // means any future content-serving path also gets the redacted bytes). Skip
      // entirely (no reads/writes) for non-protected runs. Best-effort: a per-file
      // failure must never mask the run's terminal result.
      if (isRedacting) {
        try {
          const manifest = await workspace.bundleResult(workspaceId);
          for (const entry of manifest) {
            try {
              const raw = await workspace.readFile(workspaceId, entry.path);
              const redacted = redactOutput(raw);
              if (redacted !== raw) {
                await workspace.writeFile(workspaceId, entry.path, redacted);
              }
            } catch {
              /* unreadable / non-UTF8 file — skip; never abort finalize */
            }
          }
        } catch {
          /* manifest unavailable — fall through to the bundle below */
        }
      }
      // Always capture whatever the run produced, even on a partial stop. The
      // manifest paths themselves can carry a leak (the model can NAME a file after
      // the prompt), so redact each path too; sizes reflect the rewritten content.
      const files = (await workspace.bundleResult(workspaceId).catch(() => [])).map(
        (f) => ({ ...f, path: redactOutput(f.path) }),
      );
      result = { output: redactOutput(lastText), files };
      await runs.setResult(run.id, result);
    }
    await runs.updateRunStatus(run.id, status, {
      finishedAt: now(),
      spentInferenceCents,
      spentComputeCents,
      ...(extra.error ? { error: extra.error } : {}),
    });
    return {
      status,
      result,
      error: extra.error,
      // spentCents is the TOTAL debited from the buyer: inference + the v2 compute
      // fee (invocation + active-minute) + the premium royalty. The royalty is a
      // real buyer charge but is NOT part of spentComputeCents (compute is
      // invocation + active-minute only) — it is a separate receipt line.
      spentCents: spentInferenceCents + spentComputeCents + spentRoyaltyCents,
      spentInferenceCents,
      spentComputeCents,
      spentInvocationCents,
      spentActiveMinuteCents,
      spentRoyaltyCents,
      royaltyAccrued,
      toolRounds,
    };
  };

  /** Run one inference turn under the active billing mode; returns response +
   *  the inference cents debited this turn (always 0 in BYO mode). */
  const runTurn = async (
    request: ChatRequest,
  ): Promise<{ response: ChatResponse; debitedCents: number }> => {
    if (inferenceMode === "byo") {
      // BYO: call the user's provider directly. The ledger is NOT touched for
      // inference — the user is billed by their own provider.
      const response = await chatProvider.sendMessage(request);
      return { response, debitedCents: 0 };
    }
    const turn = await runManagedTurn(
      {
        chatProvider,
        ledger,
        now,
        ...(deps.markupBps !== undefined ? { markupBps: deps.markupBps } : {}),
      },
      {
        userId: run.userId,
        request,
        sourceRef: `auto-run:${run.id}`,
      },
    );
    return { response: turn.response, debitedCents: turn.debitedCents };
  };

  try {
    if (chargeRunFee) {
      // Up-front v2 run fee. Insufficient balance → debit/reserveHold throws; the
      // catch below records the run as failed. (web-forge pre-checks this before
      // dispatch for a clean 402, but the worker path is defended here too.)
      await ledger.ensureAccount(run.userId, now());

      // TRULY-FREE TRIAL: remaining free active-minutes this UTC month waive
      // the invocation fee and shrink the up-front hold, so a $0-balance user
      // can genuinely use the free tier (matches checkAffordability's
      // zero-balance admission). Metering still depletes the allowance at
      // settle. A failed allowance read → no grace (conservative: the paid
      // path is unaffected).
      let freeMinutesRemainingAtStart = 0;
      if (freeActiveMinutesPerMonth > 0) {
        try {
          const used = await ledger.getFreeMinutesUsed(run.userId, FREE_TRIAL_PERIOD_KEY);
          freeMinutesRemainingAtStart = Math.max(0, freeActiveMinutesPerMonth - used);
        } catch {
          /* no grace */
        }
      }

      // 1) Invocation fee: a single idempotent debit at run start. The
      //    `auto-invocation-{runId}` sourceRef makes a retried run a no-op
      //    double-charge-wise (the ledger dedupes on sourceRef). Debited here so
      //    even a 0-minute run still pays the flat fee. WAIVED while any free
      //    minutes remain (truly-free trial).
      if (invocationFeeCents > 0 && freeMinutesRemainingAtStart === 0) {
        await ledger.debit(
          run.userId,
          invocationFeeCents,
          now(),
          "Auto run invocation fee",
          `auto-invocation-${run.id}`,
        );
        spentInvocationCents = invocationFeeCents;
        await runs.recordSpend(run.id, invocationFeeCents);
      }

      // 2) Active-minute fee: reserve the up-front hold for the budget-derived
      //    estimated minutes MINUS the remaining free allowance; settled with
      //    the ACTUAL ceil(minutes) at finalize. PLUS the PREMIUM royalty (M6):
      //    grow the SAME hold by premiumRoyaltyCents so the royalty settles from
      //    it on a billable terminal state (and rides the release on failure).
      //    The royalty is NOT waived by the free-minutes grace — the free trial
      //    only covers Auto's own compute fee, never a seller's royalty. With
      //    chargeRoyalty false this term is 0 → the hold is identical to today.
      const holdCents =
        Math.max(0, estimatedMin - freeMinutesRemainingAtStart) * activeMinuteRateCents +
        (chargeRoyalty ? premiumRoyaltyCents : 0);
      if (holdCents > 0) {
        runFeeHoldId = await ledger.reserveHold(run.userId, holdCents, now());
        runFeeHoldCents = holdCents;
      }
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Guard: kill-switch.
      if (await runs.isCancelRequested(run.id)) {
        return await finalize("canceled");
      }
      // Guard: budget cap (before spending more). In managed mode this is the
      // inference spend; in BYO mode budget bounds the active-minute wall-clock.
      if (spentInferenceCents >= budgetCents) {
        return await finalize("budget_exceeded");
      }
      // Guard: v2 active-minute wall-clock cap derived from the budget. Applies
      // whenever the active-minute fee is active (managed AND BYO) so a run can't
      // bill more active minutes than the budget funds.
      if (
        activeMinuteRateCents > 0 &&
        estimatedMin > 0 &&
        elapsedMinutes(startedAtIso, now()) >= estimatedMin
      ) {
        return await finalize("budget_exceeded");
      }

      const request: ChatRequest = {
        model: run.model,
        system,
        messages,
        tools,
        maxTokens,
      };

      const turn = await runTurn(request);

      // Record the actual metered inference spend for this turn (0 for BYO).
      // Accumulate the INFERENCE total locally (recordSpend tracks the run's
      // overall spentCents, which now also includes the v2 invocation/active-min
      // fees, so its return must NOT be used as the inference subtotal).
      if (turn.debitedCents > 0) {
        spentInferenceCents += turn.debitedCents;
        await runs.recordSpend(run.id, turn.debitedCents);
      }

      const content = turn.response.content;
      lastText = textOf(content);

      // Append the assistant message to history.
      messages.push({ role: "assistant", content });

      const toolUses = toolUsesOf(content);
      if (turn.response.stopReason !== "tool_use" || toolUses.length === 0) {
        // Natural completion.
        return await finalize("succeeded");
      }

      // Budget exhausted by this turn → stop before running tools / next turn.
      if (spentInferenceCents >= budgetCents) {
        return await finalize("budget_exceeded");
      }

      // Cancel requested mid-flight → stop before executing tools.
      if (await runs.isCancelRequested(run.id)) {
        return await finalize("canceled");
      }

      if (toolRounds >= maxToolRounds) {
        return await finalize("failed", {
          error: `Run exceeded the tool-use round limit (${maxToolRounds}).`,
        });
      }
      toolRounds += 1;

      // Execute each tool_use through the sandbox executor (the hands).
      const resultBlocks: ContentBlock[] = [];
      for (const tu of toolUses) {
        const outcome = await executeTool({
          toolUseId: tu.id,
          name: tu.name,
          input: tu.input,
        });
        const isError = "error" in outcome && typeof outcome.error === "string";
        const payload = isError
          ? (outcome as { error: string }).error
          : stringifyToolResult((outcome as { result?: unknown }).result);
        resultBlocks.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: payload,
        });
      }
      messages.push({ role: "user", content: resultBlocks });
    }
  } catch (err) {
    return await finalize("failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result ?? null);
  } catch {
    return String(result);
  }
}
