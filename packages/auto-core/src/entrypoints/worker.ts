/**
 * processAutoRun — the runtime-agnostic worker that executes one autonomous run
 * end to end. This is the function a Fargate task / k8s Job / in-process dev
 * runner invokes. It contains NO AWS-specific dispatch (no SQS/Lambda glue) —
 * the caller is responsible for getting a runId here.
 *
 * Sequence:
 *   1. load the run; require status "queued".
 *   2. resolve the standing approval and ENFORCE the approval gate:
 *        - a non-revoked approval for (userId, kitRef) must exist;
 *        - run.budgetCents <= approval.maxBudgetCents.
 *      (kit mismatch / no approval / over-ceiling → run marked failed.)
 *   3. resolve kit context (system prompt + tools) via an injected hook, so this
 *      package never hard-depends on web-forge / a KitStore.
 *   4. create the workspace, seed input files, build the sandbox executor.
 *   5. runAutoRun (the driver does budget + cancel guards + billing reuse).
 *   6. cleanup the workspace.
 */

import type { ChatProvider, CreditLedgerRepository, ToolDefinition } from "@agentkitforge/gateway-core";
import type { AutoStorageDeps, EmailSender } from "../core/ports.js";
import type { AutoApproval, AutoRun, InferenceMode } from "../core/types.js";
import { makeSandboxExecutor } from "../core/sandbox-executor.js";
import { runAutoRun, type RunAutoRunResult } from "../core/run-driver.js";
import { makePromptRedactor } from "../core/leakage-guard.js";
import { deliverResult } from "../core/delivery.js";
import type { DnsResolver, FetchFn } from "../core/http-fetch.js";

/** The kit context the run needs: a system prompt + the tools the kit declares. */
export interface ResolvedKitContext {
  /** Rendered kit context / system prompt injected as the system message. */
  systemPrompt?: string;
  kitContext?: string;
  /** Tools the kit declares (Anthropic tool-definition shape). */
  tools: ToolDefinition[];
  /** Tool names the kit declares (used to intersect with the approval). */
  toolNames: string[];
  /**
   * True when this is a PROTECTED (paid / online-only) Market kit whose system
   * prompt is the seller's IP and must never reach the buyer. When set, the worker
   * binds an output redactor to `systemPrompt` so any verbatim leak in the run's
   * output / workspace files is masked before it is stored or delivered (M6 — best
   * effort, see leakage-guard.ts). Absent / false → no redaction (local / free /
   * self-host runs are unaffected).
   */
  protected?: boolean;
}

/** Hook that resolves a run's kit context. Injected; no hard web-forge dep. */
export type ResolveKitContext = (run: AutoRun, approval: AutoApproval) => Promise<ResolvedKitContext>;

export interface ProcessAutoRunDeps {
  storage: AutoStorageDeps;
  /**
   * Provider used for inference. In MANAGED mode this is the platform-key
   * provider (gateway-core). In BYO mode it is the user-key provider; pass it
   * here (or via byoChatProvider) and set inferenceMode "byo".
   */
  chatProvider: ChatProvider;
  /**
   * Optional BYO provider (user's own key). When the run's inferenceMode is
   * "byo" this provider is used instead of `chatProvider`; the credit ledger is
   * NOT debited for inference. Falls back to `chatProvider` if unset.
   */
  byoChatProvider?: ChatProvider;
  /** The gateway credit ledger (gateway-core). */
  ledger: CreditLedgerRepository;
  /** Resolves kit context for the run (system prompt + tools). */
  resolveKitContext: ResolveKitContext;
  /** Clock — ISO 8601. */
  now: () => string;
  /**
   * Inference billing mode override. When omitted, the run record's
   * `inferenceMode` is used (default "managed"). Markup applies in managed mode.
   */
  inferenceMode?: InferenceMode;
  /** Markup in bps for managed turns (Auto's own rate; v2 default 0 = at cost). */
  markupBps?: number;
  /**
   * Auto v2 flat invocation fee (US cents), debited once at run start. Default 0
   * (disabled). Non-zero only on the HOSTED managed path (resolved by run-task
   * from @agentkit-commercial/gateway); 0 keeps open-core / self-host free.
   */
  invocationFeeCents?: number;
  /**
   * Auto v2 per-active-minute fee (US cents). Default 0 (disabled). Non-zero only
   * on the HOSTED managed path; 0 keeps open-core / self-host free.
   */
  activeMinuteRateCents?: number;
  /**
   * Auto v2 FREE active-minute allowance per user per calendar-month (Slice 2).
   * The first N active-minutes a user consumes in a UTC month are NOT charged the
   * active-minute fee (the invocation fee is always charged). Default 0 (no free
   * tier). Non-zero only on the HOSTED managed path; 0 keeps self-host un-metered.
   */
  freeActiveMinutesPerMonth?: number;
  maxTokens?: number;
  maxToolRounds?: number;
  /**
   * GOVERNANCE ACCOUNTING (org budgets v2) — best-effort, open-core-safe. Forwarded
   * verbatim to the run-driver, which calls it ONCE at finalize with the run's
   * final spend + elapsed active-minutes. Default undefined → no-op (open-core /
   * self-host). Never throws, never affects the run result.
   */
  recordOrgUsage?: (info: {
    userId: string;
    period: string;
    cents: number;
    minutes: number;
  }) => Promise<void>;
  /**
   * Opt-in result delivery (Phase D). When a run carries a `deliveryConfig`,
   * these deps are used AFTER the run reaches a terminal status to notify the
   * user. Delivery is best-effort — a failure here NEVER fails the run.
   *   - `emailSender`: provider-specific (SES on aws / no-op self-host). When
   *     omitted, email channels are skipped.
   *   - `deliveryFetch` + `deliveryResolver`: the webhook POST + its SSRF guard.
   *     When either is omitted, webhook channels are skipped.
   */
  emailSender?: EmailSender;
  deliveryFetch?: FetchFn;
  deliveryResolver?: DnsResolver;
}

/** Raised + recorded when the approval gate denies a run. */
export class ApprovalDeniedError extends Error {
  readonly name = "ApprovalDeniedError";
}

export async function processAutoRun(
  runId: string,
  deps: ProcessAutoRunDeps,
): Promise<RunAutoRunResult> {
  const { storage, now } = deps;
  const { runs, approvals, workspaces, inputs } = storage;

  const run = await runs.getRun(runId);
  if (!run) throw new Error(`Auto run not found: ${runId}`);

  // ---- Approval gate ------------------------------------------------------
  const approval = await approvals.getApprovalForKit(run.userId, run.kitRef);
  const denyAndFail = async (reason: string): Promise<never> => {
    await runs.updateRunStatus(runId, "failed", { finishedAt: now(), error: reason });
    throw new ApprovalDeniedError(reason);
  };
  if (!approval) {
    await denyAndFail("No standing approval exists for this kit.");
  }
  const appr = approval as AutoApproval;
  if (appr.revokedAt !== null) {
    await denyAndFail("The standing approval for this kit has been revoked.");
  }
  // maxBudgetCents 0 = UNLIMITED (no per-run ceiling) — never blocks.
  if (appr.maxBudgetCents > 0 && run.budgetCents > appr.maxBudgetCents) {
    await denyAndFail(
      `Run budget (${run.budgetCents}¢) exceeds the approval ceiling (${appr.maxBudgetCents}¢).`,
    );
  }

  // ---- Resolve kit context ------------------------------------------------
  // Context resolution can fail closed — e.g. a PROTECTED Market kit whose buyer
  // is no longer entitled (the Market service returns 403 → the resolver throws).
  // That refusal MUST mark the run terminal (failed), not leave it stuck "queued":
  // a stuck queued run would never reach a terminal status, never settle billing,
  // and could be re-picked by a retry. We record the failure and re-throw the
  // ORIGINAL error (status only — never a message that could echo kit text). The
  // resolver itself is contracted to never put the kit prompt in its error message.
  let kit: ResolvedKitContext;
  try {
    kit = await deps.resolveKitContext(run, appr);
  } catch (err) {
    await runs.updateRunStatus(runId, "failed", {
      finishedAt: now(),
      error: err instanceof Error ? err.message : "kit context resolution failed",
    });
    throw err;
  }

  // ---- Billing mode + provider selection ---------------------------------
  const inferenceMode: InferenceMode =
    deps.inferenceMode ?? run.inferenceMode ?? "managed";
  const inferenceProvider =
    inferenceMode === "byo" && deps.byoChatProvider
      ? deps.byoChatProvider
      : deps.chatProvider;

  // ---- Workspace + executor ----------------------------------------------
  const workspaceId = await workspaces.createWorkspace(run.id);
  await runs.updateRunStatus(runId, "running", { startedAt: now(), workspaceId });
  const runWithWs: AutoRun = { ...run, status: "running", workspaceId };

  try {
    // Seed inline input files into the workspace root (Phase A).
    for (const f of run.input.files ?? []) {
      await workspaces.writeFile(workspaceId, f.path, f.content);
    }

    // Hydrate out-of-band staged input files into the workspace `inputs/` subdir
    // (Phase C). Path-confined by the InputStore + WorkspaceStore. A staged file
    // that is missing/unreadable is skipped by the store (best-effort), so a
    // partial manifest never aborts the run.
    if (run.inputFiles && run.inputFiles.length > 0) {
      await inputs.hydrateInputsIntoWorkspace(run.id, workspaces, workspaceId, run.inputFiles);
    }

    const executeTool = makeSandboxExecutor({
      workspace: workspaces,
      workspaceId,
      runId: run.id,
      approval: appr,
      repo: runs,
      resolvedTools: kit.toolNames,
      now,
    });

    // PROTECTED-KIT OUTPUT REDACTION (M6 content protection). For a protected kit
    // we bind a redactor to the resolved system prompt; the driver passes the run
    // output AND any workspace file contents through it before they are stored /
    // returned / delivered, masking verbatim leaks. Non-protected runs pass no
    // redactor → the driver applies identity (no-op), so open-core / self-host /
    // local / free runs are byte-for-byte unaffected. Best-effort deterrent only
    // (see leakage-guard.ts — paraphrase / inference extraction defeats it).
    const redactOutput =
      kit.protected && kit.systemPrompt
        ? makePromptRedactor(kit.systemPrompt)
        : undefined;

    const result = await runAutoRun({
      run: runWithWs,
      approval: appr,
      ...(redactOutput ? { redactOutput } : {}),
      ...(kit.systemPrompt !== undefined ? { systemPrompt: kit.systemPrompt } : {}),
      ...(kit.kitContext !== undefined ? { kitContext: kit.kitContext } : {}),
      tools: kit.tools,
      executeTool,
      deps: {
        chatProvider: inferenceProvider,
        ledger: deps.ledger,
        runs,
        workspace: workspaces,
        now,
        inferenceMode,
        ...(deps.markupBps !== undefined ? { markupBps: deps.markupBps } : {}),
        ...(deps.invocationFeeCents !== undefined
          ? { invocationFeeCents: deps.invocationFeeCents }
          : {}),
        ...(deps.activeMinuteRateCents !== undefined
          ? { activeMinuteRateCents: deps.activeMinuteRateCents }
          : {}),
        ...(deps.freeActiveMinutesPerMonth !== undefined
          ? { freeActiveMinutesPerMonth: deps.freeActiveMinutesPerMonth }
          : {}),
        ...(deps.maxTokens !== undefined ? { maxTokens: deps.maxTokens } : {}),
        ...(deps.recordOrgUsage !== undefined
          ? { recordOrgUsage: deps.recordOrgUsage }
          : {}),
      },
      ...(deps.maxToolRounds !== undefined ? { maxToolRounds: deps.maxToolRounds } : {}),
    });

    // ---- Opt-in result delivery (Phase D) --------------------------------
    // Fires AFTER the run reaches a terminal status (success OR failure — the
    // user wants to be notified of failures too). Best-effort: any delivery
    // failure is logged + audited inside deliverResult, never fatal to the run.
    if (run.deliveryConfig) {
      try {
        await deliverResult({
          run: { ...runWithWs, status: result.status, finishedAt: now() },
          result: {
            status: result.status,
            output: result.result?.output ?? "",
            spentCents: result.spentCents,
          },
          config: run.deliveryConfig,
          deps: {
            runs,
            ...(deps.emailSender ? { emailSender: deps.emailSender } : {}),
            ...(deps.deliveryFetch ? { fetchFn: deps.deliveryFetch } : {}),
            ...(deps.deliveryResolver ? { resolver: deps.deliveryResolver } : {}),
          },
          now,
        });
      } catch (err) {
        // Defensive: deliverResult is contracted not to throw, but never let a
        // delivery hiccup mask the run's real terminal result.
        console.error(
          `Auto run ${run.id} delivery error (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return result;
  } finally {
    // Ephemeral workspace — always cleaned up after the run resolves.
    await workspaces.cleanup(workspaceId).catch(() => {});
  }
}
