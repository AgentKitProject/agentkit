// MIRROR of apps/auto-web/server/core/can-start.ts (forge hosts the same Auto
// surface; keep the two in lockstep).
//
// COST-PREFLIGHT seam (canStartRun) — builds the affordability pre-check the
// trigger layer calls BEFORE any run dispatch, so no compute is spent for a
// user who can't pay.
//
// The verdict itself is computed by the GATEWAY (the sole holder of the credit
// ledger) via the service-key-gated `POST /gateway/ledger/can-start` read — the
// same `/gateway/ledger/*` seam startRun's balance pre-check uses. This module
// only WIRES that read behind the contracts shape:
//
//   - gateway configured (GATEWAY_INTERNAL_BASE_URL + GATEWAY_SERVICE_KEY)
//       → ask it; pass its {allowed, reason?, detail?} verdict through.
//   - no gateway configured (self-host free / BYO-only deployment)
//       → always { allowed: true }: runs are unmetered here, there is nothing
//         to afford, and local-first must never require a server.
//   - gateway UNREACHABLE / erroring → fail CLOSED for "managed"
//       ({ allowed:false, reason:"ledger_unavailable" } — never start an
//       unbillable managed run) and fail OPEN for "byo" (their tokens are on
//       their own key; only our small run fee is at risk), per
//       CAN_START_FAIL_CLOSED_MODES.
//
// NOT yet wired into startRun/routes — the trigger-runner consumes this via an
// injected port, and a later integration pass owns the consume path.

import {
  CAN_START_FAIL_CLOSED_MODES,
  canStartRunResponseSchema,
  type CanStartRunRequest,
  type CanStartRunResponse,
} from "@agentkitforge/contracts";
import { HttpLedgerClient } from "@agentkitforge/auto-core";

/** The one gateway call this module needs (HttpLedgerClient satisfies it). */
export interface CanStartGatewayClient {
  canStartRun(input: {
    userId: string;
    mode: "managed" | "byo";
  }): Promise<{ allowed: boolean; reason?: string; detail?: string }>;
}

/** Dependencies for buildCanStartRun. */
export interface BuildCanStartRunDeps {
  /**
   * Gateway ledger client, or null/undefined when NO gateway is configured
   * (self-host / free deployment) — then every check answers { allowed: true }.
   */
  gatewayClient?: CanStartGatewayClient | null;
}

/** The injected port shape the trigger layer consumes. */
export type CanStartRun = (req: CanStartRunRequest) => Promise<CanStartRunResponse>;

/**
 * Builds the canStartRun function. Pure wiring — never throws: every failure
 * mode collapses into a verdict per the fail-closed-for-managed policy.
 */
export function buildCanStartRun(deps: BuildCanStartRunDeps = {}): CanStartRun {
  const client = deps.gatewayClient ?? null;
  return async (req: CanStartRunRequest): Promise<CanStartRunResponse> => {
    if (!client) {
      // No gateway → unmetered deployment → nothing to afford.
      return { allowed: true };
    }
    try {
      const raw = await client.canStartRun({ userId: req.userId, mode: req.mode });
      const parsed = canStartRunResponseSchema.safeParse(raw);
      if (!parsed.success) {
        // A malformed verdict is indistinguishable from a broken ledger seam.
        throw new Error("malformed can-start response");
      }
      return parsed.data;
    } catch {
      // Ledger unreachable/erroring: closed for managed, open for BYO.
      const allowed = !CAN_START_FAIL_CLOSED_MODES.includes(req.mode);
      return { allowed, reason: "ledger_unavailable" };
    }
  };
}

/**
 * Builds the gateway ledger client from the SAME env pair the run-fee path
 * uses (GATEWAY_INTERNAL_BASE_URL + GATEWAY_SERVICE_KEY — see selectLedger in
 * server/core/auto.ts in auto-web; forge mirrors the pair). Returns undefined when either is absent — i.e. no
 * gateway is configured and the preflight is a no-op allow.
 */
export function gatewayCanStartClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CanStartGatewayClient | undefined {
  const baseUrl = env.GATEWAY_INTERNAL_BASE_URL?.trim();
  const serviceKey = env.GATEWAY_SERVICE_KEY?.trim();
  if (!baseUrl || !serviceKey) return undefined;
  return new HttpLedgerClient({ baseUrl, serviceKey });
}

/** Convenience composition: env-configured gateway (or the no-op allow). */
export function makeDefaultCanStartRun(env: NodeJS.ProcessEnv = process.env): CanStartRun {
  return buildCanStartRun({ gatewayClient: gatewayCanStartClientFromEnv(env) ?? null });
}
