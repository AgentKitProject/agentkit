/**
 * Pre-run Approve/Deny resolution (Wave 4).
 *
 * A `requireApproval` trigger fire that passes every gate is HELD by
 * consumeTriggerEvent (fire-log "awaiting_approval") as a PendingTriggerApproval
 * carrying the sha256 hash of a one-time token; the plaintext rides ONLY in the
 * Approve/Deny button callback data of the prompt message (S2: never stored,
 * never logged).
 *
 * `resolvePendingApprovalToken` is the ONLY resolution path — button callbacks
 * from every platform (Slack interactivity / Telegram callback_query / Discord
 * component interaction) land here after the ingest route's signature
 * verification:
 *
 *   - token lookup by HASH (constant-time semantics: exact-match hash lookup +
 *     verifyWebhookSecret double-check, mirroring the ingest bearer-token path);
 *   - single-consume: PendingApprovalRepository.resolvePending flips status only
 *     from "pending" — a double click can never fire twice;
 *   - expiry is enforced lazily at resolution time (TTL from contracts);
 *   - APPROVE re-presents the HELD event through the FULL consumeTriggerEvent
 *     gate chain with `preApproved` (S4: approvals are only ever PRE-run — a
 *     fresh, fully-gated run per event; nothing here can touch an in-flight
 *     run). Rate/funds/approval gates re-run against the CURRENT state.
 *   - DENY/EXPIRED append an "approval_denied" fire log; no run.
 */

import type { ConsumeTriggerEventDeps } from "./trigger-runner.js";
import { consumeTriggerEvent } from "./trigger-runner.js";
import type { TriggerFireLog } from "./types.js";
import { hashWebhookSecret, verifyWebhookSecret } from "./webhook-secret.js";
import { originFromMessagePayload } from "./messaging.js";

/** The outcome of one Approve/Deny callback resolution. */
export interface ResolvePendingApprovalResult {
  outcome: "approved" | "denied" | "expired" | "not_found";
  /** The fire log appended by the resolution (approve/deny/expire paths). */
  fireLog?: TriggerFireLog;
  /** The run created by an approve (fireLog.outcome === "run_created"). */
  runId?: string;
}

/**
 * Resolves one presented approval token. `expectedUserId` is the OWNERSHIP
 * gate: the ingest route passes the event source's userId, so a token can only
 * be resolved on a source owned by the same user that owns the held trigger.
 * Uniform "not_found" for missing/foreign/already-resolved tokens (no probing).
 */
export async function resolvePendingApprovalToken(
  presentedToken: string,
  decision: "approve" | "deny",
  expectedUserId: string,
  deps: ConsumeTriggerEventDeps,
  nowISO: string,
): Promise<ResolvePendingApprovalResult> {
  if (!deps.pendingApprovals) return { outcome: "not_found" };

  const pending = await deps.pendingApprovals.findByTokenHash(hashWebhookSecret(presentedToken));
  if (!pending || pending.status !== "pending") return { outcome: "not_found" };
  // Defense in depth: re-verify the presented token against the stored hash
  // (constant-time), exactly like the ingest bearer-token path.
  if (!verifyWebhookSecret(presentedToken, pending.tokenHash)) return { outcome: "not_found" };
  if (pending.userId !== expectedUserId) return { outcome: "not_found" };

  const appendDenied = async (detail: string): Promise<TriggerFireLog> =>
    deps.fireLogs.appendFireLog({
      triggerId: pending.triggerId,
      at: nowISO,
      outcome: "approval_denied",
      runId: null,
      detail,
    });

  // Lazy expiry: past-TTL holds can no longer be approved.
  if (Date.parse(nowISO) > Date.parse(pending.expiresAt)) {
    await deps.pendingApprovals.resolvePending(pending.id, "expired", nowISO);
    const fireLog = await appendDenied("Pre-run approval expired before it was actioned.");
    return { outcome: "expired", fireLog };
  }

  if (decision === "deny") {
    const resolved = await deps.pendingApprovals.resolvePending(pending.id, "denied", nowISO);
    if (!resolved) return { outcome: "not_found" }; // raced with another click
    const fireLog = await appendDenied("Pre-run approval denied.");
    return { outcome: "denied", fireLog };
  }

  // APPROVE — atomic single consume FIRST (a second click finds it resolved).
  const resolved = await deps.pendingApprovals.resolvePending(pending.id, "approved", nowISO);
  if (!resolved) return { outcome: "not_found" };

  const trigger = await deps.triggers.getTrigger(pending.triggerId);
  if (!trigger) {
    const fireLog = await appendDenied("Trigger no longer exists.");
    return { outcome: "denied", fireLog };
  }

  // Re-present the HELD event through the FULL gate chain (fresh clock so rate
  // limits/funds/circuit apply to the CURRENT state — S4). Message origins are
  // re-derived from the held payload so replies still land on the thread.
  const origin =
    trigger.type === "message"
      ? originFromMessagePayload(trigger.config.platform, pending.event.payload)
      : undefined;
  const fireLog = await consumeTriggerEvent(
    trigger,
    {
      name: pending.event.name,
      ...(pending.event.payload !== undefined ? { payload: pending.event.payload } : {}),
      receivedAt: nowISO,
      preApproved: true,
      ...(origin !== undefined ? { origin } : {}),
    },
    deps,
  );
  return {
    outcome: "approved",
    fireLog,
    ...(fireLog.runId !== null && fireLog.runId !== undefined ? { runId: fireLog.runId } : {}),
  };
}
