/**
 * Hosted managed-gateway composition root (entrypoints/managed-server.ts).
 *
 * Test-mode only: pg-mem (no real Postgres), a MOCKED ChatProvider (no real
 * inference), and a FAKE commercial overlay injected via the importer seam (no
 * dependency on the private @agentkit-commercial/gateway package).
 *
 * Covered:
 *   - commercial PRESENT → the composition loads the overlay ledger, applies the
 *     session + commercial schema, flags commercialLoaded, and a managed turn
 *     reserves + settles credits against it;
 *   - commercial ABSENT → degrades to the in-memory ledger (free/BYO fallback),
 *     no throw, and a managed turn still reserves + settles after a topup;
 *   - the public session schema is actually applied (gateway_sessions queryable).
 */

import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import {
  composeManagedGateway,
  type CommercialImporter,
  type SchemaApplyPool,
} from "../src/entrypoints/managed-server.js";
import { runManagedTurn } from "../src/core/services/managed-turn.js";
import { InMemoryCreditLedgerRepository } from "../src/adapters/memory/credit-ledger.js";
import type { ChatProvider, CreditLedgerRepository } from "../src/core/ports.js";
import type { ChatRequest, ChatResponse } from "../src/core/types.js";

const NOW = "2026-06-25T00:00:00.000Z";

function freshPool(): SchemaApplyPool {
  const db = newDb();
  // pg-mem has no advisory-lock built-ins; register no-op stand-ins so the
  // composition root's real `pg_advisory_lock`/`unlock` startup path is exercised
  // (and proven harmless) under the in-memory DB.
  db.public.registerFunction({
    name: "pg_advisory_lock",
    args: ["integer" as never],
    returns: "bool" as never,
    implementation: () => true,
  } as never);
  db.public.registerFunction({
    name: "pg_advisory_unlock",
    args: ["integer" as never],
    returns: "bool" as never,
    implementation: () => true,
  } as never);
  const { Pool } = db.adapters.createPg();
  return new Pool() as unknown as SchemaApplyPool;
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

const chatRequest: ChatRequest = {
  model: "claude-sonnet-4-6",
  system: "s",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  maxTokens: 256,
};

/**
 * A fake commercial overlay: its ledger is a (fully-funded-via-topup) in-memory
 * ledger so the managed turn can reserve + settle. The schema SQL is a trivial
 * idempotent table create, proving the composition applies the commercial DDL
 * alongside the session DDL.
 */
function fakeCommercialImporter(ledger: CreditLedgerRepository): CommercialImporter {
  return async () => ({
    createPostgresCreditLedger: () => ledger,
    GATEWAY_LEDGER_SCHEMA_SQL:
      "CREATE TABLE IF NOT EXISTS gateway_credit_accounts_probe (user_id TEXT PRIMARY KEY);",
  });
}

describe("managed gateway composition root", () => {
  it("commercial PRESENT → loads the overlay ledger, applies both schemas, managed turn debits", async () => {
    const pool = freshPool();
    const ledger = new InMemoryCreditLedgerRepository();
    await ledger.ensureAccount("u1", NOW);
    await ledger.topup("u1", 100_000, NOW, "test-grant");

    const composed = await composeManagedGateway({
      pool,
      chatProvider: new FakeProvider(),
      now: () => NOW,
      markupBps: 1500,
      commercialImporter: fakeCommercialImporter(ledger),
    });

    expect(composed.commercialLoaded).toBe(true);
    expect(composed.ledger).toBe(ledger);

    // Both schemas applied: the public session table AND the commercial DDL.
    await expect(
      pool.query("SELECT COUNT(*) AS n FROM gateway_sessions"),
    ).resolves.toBeDefined();
    await expect(
      pool.query("SELECT COUNT(*) AS n FROM gateway_credit_accounts_probe"),
    ).resolves.toBeDefined();

    // A managed turn reserves + settles credits against the loaded ledger.
    const before = (await ledger.getAccount("u1"))!.availableBalanceCents;
    const result = await runManagedTurn(composed.managedTurnDeps, {
      userId: "u1",
      request: chatRequest,
    });
    const after = (await ledger.getAccount("u1"))!.availableBalanceCents;

    expect(result.debitedCents).toBeGreaterThan(0);
    expect(after).toBe(before - result.debitedCents);
  });

  it("commercial ABSENT → in-memory ledger fallback (no throw), managed turn still works", async () => {
    const pool = freshPool();

    const composed = await composeManagedGateway({
      pool,
      chatProvider: new FakeProvider(),
      now: () => NOW,
      markupBps: 1500,
      // Simulate the public / self-host build: the dynamic import rejects.
      commercialImporter: async () => {
        throw new Error("Cannot find module '@agentkit-commercial/gateway'");
      },
    });

    expect(composed.commercialLoaded).toBe(false);
    expect(composed.ledger).toBeInstanceOf(InMemoryCreditLedgerRepository);

    // Fund the in-memory ledger, then a managed turn reserves + settles.
    await composed.ledger.ensureAccount("u2", NOW);
    await composed.ledger.topup("u2", 100_000, NOW, "test-grant");

    const result = await runManagedTurn(composed.managedTurnDeps, {
      userId: "u2",
      request: chatRequest,
    });
    expect(result.debitedCents).toBeGreaterThan(0);
    expect(result.balanceCents).toBe(100_000 - result.debitedCents);
  });

  it("composes full router deps (session + turn) for serving the gateway contract", async () => {
    const pool = freshPool();
    const composed = await composeManagedGateway({
      pool,
      chatProvider: new FakeProvider(),
      now: () => NOW,
      commercialImporter: async () => {
        throw new Error("absent");
      },
    });

    expect(composed.routerDeps.session.sessions).toBe(composed.sessions);
    expect(composed.routerDeps.turn.ledger).toBe(composed.ledger);
    expect(composed.routerDeps.turn.chatProvider).toBe(composed.chatProvider);
  });
});
