/**
 * L4 concurrency cap (core/concurrency.ts) — pure helpers + the read.
 * Proves: the checkConcurrency boundary math, the AUTO_MAX_CONCURRENT_RUNS
 * env-override pattern (invalid → default), which statuses count as active,
 * and that countActiveRuns prefers a repository's native count but falls back
 * to a newest-first listRunsByUser scan for base-port repositories/fakes.
 */

import { describe, it, expect } from "vitest";
import {
  ACTIVE_RUN_STATUSES,
  DEFAULT_MAX_CONCURRENT_RUNS,
  MAX_CONCURRENT_RUNS_ENV_VAR,
  checkConcurrency,
  countActiveRuns,
  isActiveRunStatus,
  resolveMaxConcurrentRuns,
} from "../src/core/concurrency.js";
import type { AutoRun, AutoRunStatus } from "../src/core/types.js";

// ---------------------------------------------------------------------------
// checkConcurrency
// ---------------------------------------------------------------------------

describe("checkConcurrency", () => {
  it("allows while active < max", () => {
    expect(checkConcurrency({ active: 0, max: 5 })).toEqual({ allowed: true });
    expect(checkConcurrency({ active: 4, max: 5 })).toEqual({ allowed: true });
  });

  it("denies at and beyond the cap with reason concurrency_limit", () => {
    for (const active of [5, 6, 100]) {
      const verdict = checkConcurrency({ active, max: 5 });
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("concurrency_limit");
      expect(verdict.detail).toContain(String(active));
      expect(verdict.detail).toContain("5");
    }
  });

  it("clamps a nonsensical cap to 1 and a negative active count to 0", () => {
    expect(checkConcurrency({ active: 0, max: 0 })).toEqual({ allowed: true });
    expect(checkConcurrency({ active: 1, max: -3 }).allowed).toBe(false);
    expect(checkConcurrency({ active: -2, max: 1 })).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// resolveMaxConcurrentRuns (env-override pattern)
// ---------------------------------------------------------------------------

describe("resolveMaxConcurrentRuns", () => {
  it("defaults to DEFAULT_MAX_CONCURRENT_RUNS (5)", () => {
    expect(DEFAULT_MAX_CONCURRENT_RUNS).toBe(5);
    expect(resolveMaxConcurrentRuns({})).toBe(DEFAULT_MAX_CONCURRENT_RUNS);
  });

  it("honors a valid AUTO_MAX_CONCURRENT_RUNS >= 1", () => {
    expect(resolveMaxConcurrentRuns({ [MAX_CONCURRENT_RUNS_ENV_VAR]: "1" })).toBe(1);
    expect(resolveMaxConcurrentRuns({ [MAX_CONCURRENT_RUNS_ENV_VAR]: "12" })).toBe(12);
  });

  it("falls back to the default on garbage or out-of-range values", () => {
    for (const bad of ["0", "-1", "2.5", "abc", ""]) {
      expect(resolveMaxConcurrentRuns({ [MAX_CONCURRENT_RUNS_ENV_VAR]: bad })).toBe(
        DEFAULT_MAX_CONCURRENT_RUNS,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// active statuses
// ---------------------------------------------------------------------------

describe("active statuses", () => {
  it("queued + running are active; every terminal status is not", () => {
    expect(ACTIVE_RUN_STATUSES).toEqual(["queued", "running"]);
    expect(isActiveRunStatus("queued")).toBe(true);
    expect(isActiveRunStatus("running")).toBe(true);
    for (const terminal of ["succeeded", "failed", "canceled", "budget_exceeded"] as const) {
      expect(isActiveRunStatus(terminal)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// countActiveRuns (native vs fallback)
// ---------------------------------------------------------------------------

function fakeRun(status: AutoRunStatus): AutoRun {
  return {
    id: `run-${Math.random().toString(36).slice(2)}`,
    userId: "u1",
    kitRef: { source: "local", localKitId: "k1" },
    status,
    input: { prompt: "task" },
    budgetCents: 100,
    spentCents: 0,
    model: "claude-sonnet-4-6",
    createdAt: "2026-07-02T00:00:00.000Z",
    auditLog: [],
    cancelRequested: false,
  } as AutoRun;
}

describe("countActiveRuns", () => {
  it("falls back to a listRunsByUser scan filtered to active statuses", async () => {
    const listed: Array<{ userId: string; limit?: number }> = [];
    const repo = {
      listRunsByUser: async (userId: string, limit?: number) => {
        listed.push({ userId, ...(limit !== undefined ? { limit } : {}) });
        return [
          fakeRun("queued"),
          fakeRun("running"),
          fakeRun("succeeded"),
          fakeRun("failed"),
          fakeRun("running"),
        ];
      },
    };
    expect(await countActiveRuns(repo, "u1")).toBe(3);
    expect(listed[0]?.userId).toBe("u1");
    expect(listed[0]?.limit).toBeGreaterThanOrEqual(100); // wide scan page
  });

  it("prefers the repository's native countActiveRuns when present", async () => {
    let nativeCalls = 0;
    const repo = {
      listRunsByUser: async () => {
        throw new Error("must not scan when a native count exists");
      },
      countActiveRuns: async (userId: string) => {
        nativeCalls += 1;
        expect(userId).toBe("u1");
        return 4;
      },
    };
    expect(await countActiveRuns(repo, "u1")).toBe(4);
    expect(nativeCalls).toBe(1);
  });

  it("honors an explicit scanLimit on the fallback", async () => {
    let seenLimit: number | undefined;
    const repo = {
      listRunsByUser: async (_userId: string, limit?: number) => {
        seenLimit = limit;
        return [];
      },
    };
    expect(await countActiveRuns(repo, "u1", { scanLimit: 25 })).toBe(0);
    expect(seenLimit).toBe(25);
  });
});
