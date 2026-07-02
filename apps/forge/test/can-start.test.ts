// buildCanStartRun (server/core/can-start.ts) — the COST-PREFLIGHT factory.
//
// Proves the wiring policy:
//   - NO gateway configured → every check answers { allowed: true } and the
//     client is never consulted (self-host / free deployment is never gated);
//   - gateway configured → the request is forwarded and the gateway's verdict
//     passes through unchanged (allowed AND denied shapes);
//   - client error / malformed verdict → FAIL CLOSED for "managed"
//     ({allowed:false, reason:"ledger_unavailable"}), FAIL OPEN for "byo"
//     ({allowed:true, reason:"ledger_unavailable"}) per
//     CAN_START_FAIL_CLOSED_MODES — and the factory itself never throws;
//   - gatewayCanStartClientFromEnv builds a client only when BOTH
//     GATEWAY_INTERNAL_BASE_URL and GATEWAY_SERVICE_KEY are set.

import { describe, expect, it } from "vitest";
import type { CanStartRunRequest } from "@agentkitforge/contracts";
import {
  buildCanStartRun,
  gatewayCanStartClientFromEnv,
  type CanStartGatewayClient,
} from "@/server/core/can-start";

const MANAGED: CanStartRunRequest = { userId: "u1", mode: "managed" };
const BYO: CanStartRunRequest = { userId: "u1", mode: "byo" };

/** The app's ProcessEnv type requires NODE_ENV; tests only care about the pair. */
const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

function recordingClient(
  respond: () => Promise<{ allowed: boolean; reason?: string; detail?: string }>,
) {
  const calls: Array<{ userId: string; mode: string }> = [];
  const client: CanStartGatewayClient = {
    canStartRun: async (input) => {
      calls.push(input);
      return respond();
    },
  };
  return { client, calls };
}

describe("buildCanStartRun — no gateway configured", () => {
  it("always allows and never consults anything", async () => {
    const canStart = buildCanStartRun({});
    expect(await canStart(MANAGED)).toEqual({ allowed: true });
    expect(await canStart(BYO)).toEqual({ allowed: true });
    // Explicit null behaves the same.
    expect(await buildCanStartRun({ gatewayClient: null })(MANAGED)).toEqual({ allowed: true });
  });
});

describe("buildCanStartRun — gateway configured", () => {
  it("forwards the request and passes an allowed verdict through", async () => {
    const { client, calls } = recordingClient(async () => ({ allowed: true }));
    const canStart = buildCanStartRun({ gatewayClient: client });
    expect(await canStart(MANAGED)).toEqual({ allowed: true });
    expect(calls).toEqual([{ userId: "u1", mode: "managed" }]);
  });

  it("passes a denial through with reason + detail", async () => {
    const { client } = recordingClient(async () => ({
      allowed: false,
      reason: "insufficient_funds",
      detail: "needs 7c",
    }));
    const canStart = buildCanStartRun({ gatewayClient: client });
    expect(await canStart(MANAGED)).toEqual({
      allowed: false,
      reason: "insufficient_funds",
      detail: "needs 7c",
    });
  });
});

describe("buildCanStartRun — ledger unavailable (client errors)", () => {
  const throwing: CanStartGatewayClient = {
    canStartRun: async () => {
      throw new Error("gateway ledger /can-start failed: HTTP 503");
    },
  };

  it("fails CLOSED for managed", async () => {
    const canStart = buildCanStartRun({ gatewayClient: throwing });
    expect(await canStart(MANAGED)).toEqual({ allowed: false, reason: "ledger_unavailable" });
  });

  it("fails OPEN for byo", async () => {
    const canStart = buildCanStartRun({ gatewayClient: throwing });
    expect(await canStart(BYO)).toEqual({ allowed: true, reason: "ledger_unavailable" });
  });

  it("treats a malformed verdict like an unavailable ledger", async () => {
    const { client } = recordingClient(
      async () => ({ allowed: "yes" }) as unknown as { allowed: boolean },
    );
    const canStart = buildCanStartRun({ gatewayClient: client });
    expect(await canStart(MANAGED)).toEqual({ allowed: false, reason: "ledger_unavailable" });
    expect(await canStart(BYO)).toEqual({ allowed: true, reason: "ledger_unavailable" });
  });
});

describe("gatewayCanStartClientFromEnv", () => {
  it("returns undefined unless BOTH env vars are set and non-blank", () => {
    expect(gatewayCanStartClientFromEnv(env({}))).toBeUndefined();
    expect(
      gatewayCanStartClientFromEnv(env({ GATEWAY_INTERNAL_BASE_URL: "http://gw" })),
    ).toBeUndefined();
    expect(gatewayCanStartClientFromEnv(env({ GATEWAY_SERVICE_KEY: "k" }))).toBeUndefined();
    expect(
      gatewayCanStartClientFromEnv(
        env({ GATEWAY_INTERNAL_BASE_URL: "  ", GATEWAY_SERVICE_KEY: "k" }),
      ),
    ).toBeUndefined();
  });

  it("builds a client when the gateway env pair is present", () => {
    const client = gatewayCanStartClientFromEnv(
      env({
        GATEWAY_INTERNAL_BASE_URL: "http://gw.internal",
        GATEWAY_SERVICE_KEY: "svc-key",
      }),
    );
    expect(client).toBeDefined();
    expect(typeof client!.canStartRun).toBe("function");
  });
});
