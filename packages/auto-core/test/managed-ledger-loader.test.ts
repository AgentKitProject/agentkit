/**
 * Worker managed-ledger optional-load seam (G4 fix).
 *
 * `buildBackendDeps` in run-task.ts used to THROW for `selfhost + managed`
 * because the managed credit ledger lives in the private
 * `@agentkit-commercial/gateway` package. It now optionally loads that overlay
 * (mirroring auto.ts `selectLedger()` / market-core `loadCommercial()`):
 *
 *   - commercial PRESENT (hosted DOKS image): build the managed Postgres credit
 *     ledger over the worker's pool — the managed path no longer throws and
 *     debits the ledger.
 *   - commercial ABSENT (public / self-host): degrade cleanly to the inert FREE
 *     ledger (never debits; spend paths fail loudly so a misconfig can't grant
 *     unmetered inference).
 *
 * No real Postgres, no real inference: the commercial overlay is injected as a
 * fake; the managed-turn assertion uses a mocked ChatProvider.
 */

import { describe, expect, it } from "vitest";
import {
  runManagedTurn,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type CreditLedgerRepository,
  type PgPool,
} from "@agentkitforge/gateway-core";
import { loadManagedLedger } from "../src/entrypoints/run-task.js";

const NOW = "2026-06-25T00:00:00.000Z";

/** A funded, recording ledger standing in for the commercial Postgres ledger. */
class RecordingLedger implements CreditLedgerRepository {
  settled: number[] = [];
  reserved: number[] = [];
  private seq = 0;
  private account() {
    return {
      userId: "u1",
      availableBalanceCents: 1_000_000,
      heldBalanceCents: 0,
      lifetimeTopupCents: 0,
      updatedAt: NOW,
    };
  }
  async getAccount() {
    return this.account();
  }
  async ensureAccount() {
    return this.account();
  }
  async recordTransaction() {
    return { transactionId: "t", userId: "u1", type: "debit" as const, amountCents: 0, createdAt: NOW };
  }
  async topup() {
    return this.account();
  }
  async debit() {
    return this.account();
  }
  async reserveHold(_userId: string, maxCostCents: number) {
    this.reserved.push(maxCostCents);
    return `h-${++this.seq}`;
  }
  async settleHold(_holdId: string, actualCostCents: number) {
    this.settled.push(actualCostCents);
    return this.account();
  }
  async releaseHold() {
    return this.account();
  }
  async getHold() {
    return undefined;
  }
  async listTransactions() {
    return [];
  }
}

/** A mocked ChatProvider — no real Anthropic call. */
class FakeProvider implements ChatProvider {
  readonly providerType = "fake";
  calls = 0;
  async sendMessage(_request: ChatRequest): Promise<ChatResponse> {
    this.calls += 1;
    return {
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedWriteTokens: 0 },
    };
  }
  async streamMessage(): Promise<ChatResponse> {
    throw new Error("not used");
  }
}

/** A pool the factory receives; never actually queried in these tests. */
const fakePool: PgPool = {
  async query() {
    return { rows: [] };
  },
};

describe("worker managed-ledger optional load (G4)", () => {
  it("commercial PRESENT → managed path builds the ledger and a managed turn debits it (no throw)", async () => {
    const recording = new RecordingLedger();
    let factoryPool: PgPool | undefined;

    // Inject a fake commercial overlay (stands in for @agentkit-commercial/gateway).
    const ledger = await loadManagedLedger(fakePool, async () => ({
      createPostgresCreditLedger: (pool: PgPool) => {
        factoryPool = pool;
        return recording;
      },
    }));

    // The factory was handed the worker's pool (so billing rows share the DB).
    expect(factoryPool).toBe(fakePool);

    // The managed metering flow reserves + settles against the loaded ledger.
    const provider = new FakeProvider();
    const result = await runManagedTurn(
      { chatProvider: provider, ledger, now: () => NOW, markupBps: 2500 },
      {
        userId: "u1",
        request: {
          model: "claude-sonnet-4-6",
          system: "s",
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          tools: [],
          maxTokens: 256,
        },
      },
    );

    expect(provider.calls).toBe(1); // mocked inference, called once
    expect(recording.reserved.length).toBe(1); // pre-call hold reserved
    expect(recording.settled.length).toBe(1); // settled actual cost
    expect(result.debitedCents).toBeGreaterThan(0); // credits debited
  });

  it("commercial ABSENT → degrades to the inert FREE ledger (no throw on load)", async () => {
    // Simulate the public / self-host build: the dynamic import rejects.
    const ledger = await loadManagedLedger(fakePool, async () => {
      throw new Error("Cannot find module '@agentkit-commercial/gateway'");
    });

    // Read-shaped methods are inert-safe (don't throw).
    await expect(ledger.ensureAccount("u1", NOW)).resolves.toBeDefined();
    await expect(ledger.getAccount("u1")).resolves.toBeUndefined();

    // Spend paths fail loudly — a misconfigured managed run can NEVER silently
    // grant unmetered inference on the free ledger.
    await expect(ledger.reserveHold("u1", 100, NOW)).rejects.toThrow();
  });
});
