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
 *     debited at `markupBps` (Auto's own markup, e.g. 2500 = 25%) per turn. This
 *     is today's path.
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
 */

import {
  runManagedTurn,
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
 * Runs a kit autonomously to completion. Returns the terminal outcome; also
 * persists status, spend, result, and audit through the injected repo so the
 * worker/entrypoint can stay thin.
 */
export async function runAutoRun(args: RunAutoRunArgs): Promise<RunAutoRunResult> {
  const { run, tools, executeTool, deps } = args;
  const { chatProvider, ledger, runs, workspace, now } = deps;
  const maxToolRounds = args.maxToolRounds ?? 64;
  const maxTokens = deps.maxTokens ?? 4096;
  const system = args.systemPrompt ?? args.kitContext ?? "";

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
  const budgetCents = run.budgetCents;

  // ---- Auto v2 run compute fee (invocation + active-minute) -----------------
  // Generalizes the old per-minute cloud-run fee: applies to ALL runs (managed
  // AND BYO) at the v2 rates. Both rates default to 0 (open-core / self-host
  // FREE), in which case the entire fee path is skipped and the ledger is never
  // touched. The rates are non-zero only on the hosted managed path, where
  // run-task resolves them from @agentkit-commercial/gateway.
  const invocationFeeCents = Math.max(0, deps.invocationFeeCents ?? 0);
  const activeMinuteRateCents = Math.max(0, deps.activeMinuteRateCents ?? 0);
  const chargeRunFee = invocationFeeCents > 0 || activeMinuteRateCents > 0;
  // Budget-derived cap on active minutes (also caps the run's wall-clock). When
  // the active-minute rate is 0 there is no minute-derived cap (only the
  // invocation fee applies). ceil so a partial budget still funds a whole minute.
  const estimatedMin =
    activeMinuteRateCents > 0 ? Math.ceil(budgetCents / activeMinuteRateCents) : 0;
  const startedAtIso = now();
  let runFeeHoldId: string | undefined;

  /** Settle the v2 ACTIVE-MINUTE fee (idempotent — runs once): the up-front hold
   *  is settled with ceil(actual active minutes) * rate, capped by the
   *  budget-derived estimate, releasing the overshoot. The invocation fee is a
   *  separate up-front debit (see below) and is NOT part of this settle. Folds
   *  the active-minute fee into the run's persisted total spend. */
  const settleActiveMinutes = async (): Promise<void> => {
    if (runFeeHoldId === undefined) return;
    const holdId = runFeeHoldId;
    runFeeHoldId = undefined;
    let minutes = elapsedMinutes(startedAtIso, now());
    if (estimatedMin > 0) minutes = Math.min(minutes, estimatedMin);
    const activeMinuteCents =
      activeMinuteRateCents > 0 ? Math.ceil(minutes) * activeMinuteRateCents : 0;
    // Idempotent active-minute sourceRef; settles the hold (releases overshoot).
    await ledger.settleHold(holdId, activeMinuteCents, now(), `auto-active-${run.id}`);
    spentActiveMinuteCents = activeMinuteCents;
    if (activeMinuteCents > 0) await runs.recordSpend(run.id, activeMinuteCents);
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
    // Settle the v2 active-minute hold on ANY terminal outcome (completion,
    // cancel, failure, budget). Best-effort so a ledger hiccup can't mask the
    // run's real terminal status. (The invocation fee was already debited at run
    // start.)
    await settleActiveMinutes().catch(() => {});

    // spentComputeCents = the full v2 run fee (invocation + active-minutes); it
    // is what the run's spent_compute_cents column persists.
    const spentComputeCents = spentInvocationCents + spentActiveMinuteCents;

    let result: AutoRunResult | undefined;
    if (status === "succeeded" || status === "budget_exceeded" || status === "canceled") {
      // Always capture whatever the run produced, even on a partial stop.
      const files = await workspace.bundleResult(workspaceId).catch(() => []);
      result = { output: lastText, files };
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
      spentCents: spentInferenceCents + spentComputeCents,
      spentInferenceCents,
      spentComputeCents,
      spentInvocationCents,
      spentActiveMinuteCents,
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

      // 1) Invocation fee: a single idempotent debit at run start. The
      //    `auto-invocation-{runId}` sourceRef makes a retried run a no-op
      //    double-charge-wise (the ledger dedupes on sourceRef). Debited here so
      //    even a 0-minute run still pays the flat fee.
      if (invocationFeeCents > 0) {
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
      //    estimated minutes; settled with the ACTUAL ceil(minutes) at finalize.
      const holdCents = estimatedMin * activeMinuteRateCents;
      if (holdCents > 0) {
        runFeeHoldId = await ledger.reserveHold(run.userId, holdCents, now());
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
