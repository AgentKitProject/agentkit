/**
 * RSS-poller tests (Wave 3b): tolerant RSS2 + Atom parsing (CDATA, entities,
 * Atom href links), baseline-first-sweep, guid dedupe across sweeps
 * (persist-before-dispatch), per-sweep cap with next-sweep pickup, SSRF
 * rejection through the shared webhook guard, the 1 MiB response cap, HTTP
 * failure handling + circuit counting, and interval-floor gating.
 */

import { describe, expect, it } from "vitest";
import {
  parseFeedItems,
  runRssPollSweep,
  RSS_MAX_EVENTS_PER_SWEEP,
  RSS_MAX_RESPONSE_BYTES,
  type RssCursor,
  type RssPollDeps,
} from "../src/core/rss-poller.js";
import type {
  CreateAndDispatchTriggerRun,
  TriggerRunRequest,
} from "../src/core/trigger-runner.js";
import type { AutoRun, KitRef, Trigger } from "../src/core/types.js";
import type { DnsResolver, FetchFn } from "../src/core/http-fetch.js";
import { InMemoryApprovalRepo } from "./approval-repo-fake.js";
import { fakeCanStart, InMemoryFireLogRepo, InMemoryTriggerRepo } from "./fakes.js";

const KIT: KitRef = { source: "local", localKitId: "k1" };
const T0 = "2026-07-03T12:00:00.000Z";
const FEED_URL = "https://blog.example.com/feed.xml";

function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

const RSS2_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Example Blog</title>
  <item>
    <title><![CDATA[Hello <World>]]></title>
    <link>https://blog.example.com/posts/1</link>
    <guid isPermaLink="false">post-1</guid>
    <pubDate>Thu, 02 Jul 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Ampersands &amp; entities &#33;</title>
    <link>https://blog.example.com/posts/2</link>
    <guid>post-2</guid>
    <pubDate>Fri, 03 Jul 2026 09:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom</title>
  <entry>
    <title>Atom entry one</title>
    <link rel="alternate" href="https://atom.example.com/1"/>
    <id>urn:uuid:atom-1</id>
    <updated>2026-07-01T08:00:00Z</updated>
  </entry>
  <entry>
    <title>Atom entry two</title>
    <link href="https://atom.example.com/2"/>
    <id>urn:uuid:atom-2</id>
    <published>2026-07-02T08:00:00Z</published>
  </entry>
</feed>`;

describe("parseFeedItems — tolerant RSS2 + Atom extraction", () => {
  it("parses RSS2 items (CDATA titles, entities, guid, pubDate)", () => {
    const items = parseFeedItems(RSS2_FIXTURE);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: "Hello <World>",
      link: "https://blog.example.com/posts/1",
      guid: "post-1",
      publishedAt: "Thu, 02 Jul 2026 10:00:00 GMT",
    });
    expect(items[1]!.title).toBe("Ampersands & entities !");
    expect(items[1]!.guid).toBe("post-2");
  });

  it("parses Atom entries (id, href links incl. rel=alternate, updated/published)", () => {
    const items = parseFeedItems(ATOM_FIXTURE);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: "Atom entry one",
      link: "https://atom.example.com/1",
      guid: "urn:uuid:atom-1",
      publishedAt: "2026-07-01T08:00:00Z",
    });
    expect(items[1]!.guid).toBe("urn:uuid:atom-2");
    expect(items[1]!.publishedAt).toBe("2026-07-02T08:00:00Z");
  });

  it("falls back guid → link → title and drops identity-less entries; tolerates junk", () => {
    const items = parseFeedItems(
      `<rss><channel>
        <item><title>No guid</title><link>https://x.example/1</link></item>
        <item><title>Only title</title></item>
        <item><description>nothing identifying</description></item>
        <banana>junk markup</banana>
      </channel></rss>`,
    );
    expect(items).toHaveLength(2);
    expect(items[0]!.guid).toBe("https://x.example/1");
    expect(items[1]!.guid).toBe("Only title");
  });
});

// ---------------------------------------------------------------------------
// Sweep harness
// ---------------------------------------------------------------------------

function makeRssTrigger(over: Partial<Trigger> = {}, config: Record<string, unknown> = {}): Trigger {
  return {
    id: "rss-1",
    userId: "u1",
    name: "blog watch",
    type: "rss",
    config: { feedUrl: FEED_URL, intervalMinutes: 5, ...config },
    kitRef: KIT,
    approvalId: "appr-1",
    budgetCents: 200,
    mapping: { promptTemplate: "Summarize {{title}} at {{link}}.", attachPayloadAs: "event.json", fileHandling: "attach" },
    rateLimit: { maxPerHour: 500 },
    enabled: true,
    cursor: null,
    circuit: { consecutiveFailures: 0, pausedAt: null },
    createdAt: T0,
    updatedAt: T0,
    fireCount: 0,
    ...over,
  } as Trigger;
}

function fakeDispatcher(): { fn: CreateAndDispatchTriggerRun; calls: TriggerRunRequest[] } {
  const calls: TriggerRunRequest[] = [];
  let seq = 0;
  const fn: CreateAndDispatchTriggerRun = async (req) => {
    calls.push(req);
    return {
      id: `run-${++seq}`,
      userId: req.trigger.userId,
      kitRef: req.trigger.kitRef,
      status: "queued",
      input: req.input,
      budgetCents: 200,
      spentCents: 0,
      model: "claude-sonnet-4-6",
      createdAt: req.firedAt,
      auditLog: [],
    } as AutoRun;
  };
  return { fn, calls };
}

async function setup(over: {
  trigger?: Partial<Trigger>;
  config?: Record<string, unknown>;
  body?: string;
  status?: number;
  resolveTo?: string[];
} = {}) {
  const triggers = new InMemoryTriggerRepo();
  const approvals = new InMemoryApprovalRepo();
  const fireLogs = new InMemoryFireLogRepo();
  const dispatcher = fakeDispatcher();

  await approvals.createApproval({
    userId: "u1",
    kitRef: KIT,
    toolAllowlist: ["read_file"],
    maxBudgetCents: 1000,
    createdAt: T0,
  });
  const trigger = triggers.seed(makeRssTrigger(over.trigger, over.config));

  const state = { body: over.body ?? RSS2_FIXTURE, fetchCalls: 0 };
  const fetchImpl: FetchFn = async (url) => {
    state.fetchCalls += 1;
    expect(url).toBe(FEED_URL);
    return {
      status: over.status ?? 200,
      headers: { forEach: () => {} },
      text: async () => state.body,
    };
  };
  const resolver: DnsResolver = async () => over.resolveTo ?? ["93.184.216.34"];

  const deps: RssPollDeps = {
    triggers,
    approvals,
    fireLogs,
    canStartRun: fakeCanStart(true).fn,
    createAndDispatch: dispatcher.fn,
    fetchImpl,
    resolver,
  };
  return { triggers, fireLogs, dispatcher, trigger, deps, state };
}

async function cursorOf(triggers: InMemoryTriggerRepo, id: string): Promise<RssCursor> {
  const t = await triggers.getTrigger(id);
  return JSON.parse(t!.cursor as string) as RssCursor;
}

describe("rss poller — baseline, dedupe, cap", () => {
  it("first sweep BASELINES the feed (no storm); a new entry then fires exactly once", async () => {
    const { deps, triggers, dispatcher, trigger, state } = await setup();

    const first = await runRssPollSweep(deps, at(0));
    expect(first.processed).toBe(1);
    expect(first.dispatched).toBe(0);
    expect((await cursorOf(triggers, trigger.id)).seen).toEqual(["post-1", "post-2"]);

    // A new post lands at the top of the feed.
    state.body = RSS2_FIXTURE.replace(
      "<item>",
      `<item><title>Post three</title><link>https://blog.example.com/posts/3</link><guid>post-3</guid><pubDate>Sat, 04 Jul 2026 09:00:00 GMT</pubDate></item><item>`,
    );
    const second = await runRssPollSweep(deps, at(5));
    expect(second.dispatched).toBe(1);
    expect(dispatcher.calls).toHaveLength(1);
    // S1: metadata interpolated as values; the payload rides as event.json.
    expect(dispatcher.calls[0]!.input.prompt).toBe(
      "Summarize Post three at https://blog.example.com/posts/3.",
    );
    const payload = JSON.parse(dispatcher.calls[0]!.input.files![0]!.content) as Record<string, unknown>;
    expect(payload).toEqual({
      title: "Post three",
      link: "https://blog.example.com/posts/3",
      guid: "post-3",
      publishedAt: "Sat, 04 Jul 2026 09:00:00 GMT",
      feedUrl: FEED_URL,
    });

    // Third sweep, unchanged feed → no dupe.
    const third = await runRssPollSweep(deps, at(10));
    expect(third.dispatched).toBe(0);
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("caps a sweep at RSS_MAX_EVENTS_PER_SWEEP; the remainder fires next sweep (no miss, no dupe)", async () => {
    const { deps, dispatcher, state } = await setup({ body: "<rss><channel></channel></rss>" });
    await runRssPollSweep(deps, at(0)); // baseline (empty feed)

    const items = Array.from(
      { length: RSS_MAX_EVENTS_PER_SWEEP + 5 },
      (_v, i) => `<item><title>P${i}</title><guid>g-${i}</guid></item>`,
    ).join("");
    state.body = `<rss><channel>${items}</channel></rss>`;

    const second = await runRssPollSweep(deps, at(5));
    expect(second.dispatched).toBe(RSS_MAX_EVENTS_PER_SWEEP);
    const third = await runRssPollSweep(deps, at(10));
    expect(third.dispatched).toBe(5);

    const guids = dispatcher.calls.map(
      (c) => (JSON.parse(c.input.files![0]!.content) as { guid: string }).guid,
    );
    expect(new Set(guids).size).toBe(RSS_MAX_EVENTS_PER_SWEEP + 5);

    const fourth = await runRssPollSweep(deps, at(15));
    expect(fourth.dispatched).toBe(0);
  });

  it("persists the seen-set BEFORE dispatch (a crash mid-dispatch cannot re-fire)", async () => {
    const { deps, triggers, trigger, state } = await setup();
    await runRssPollSweep(deps, at(0)); // baseline
    state.body = RSS2_FIXTURE.replace(
      "<item>",
      `<item><guid>post-3</guid><title>Three</title></item><item>`,
    );
    const failing: RssPollDeps = {
      ...deps,
      createAndDispatch: async () => {
        throw new Error("dispatch exploded");
      },
    };
    const summary = await runRssPollSweep(failing, at(5));
    expect(summary.errors).toHaveLength(1);
    // The guid was acknowledged before dispatch → the retry does NOT re-fire.
    expect((await cursorOf(triggers, trigger.id)).seen).toContain("post-3");
    const retry = await runRssPollSweep(deps, at(10));
    expect(retry.dispatched).toBe(0);
  });
});

describe("rss poller — SSRF, size cap, failures, interval", () => {
  it("rejects a feed host resolving to a private address (shared webhook SSRF guard) — no fetch", async () => {
    const { deps, fireLogs, triggers, trigger, state } = await setup({ resolveTo: ["10.0.0.8"] });
    const summary = await runRssPollSweep(deps, at(0));
    expect(summary.errors).toHaveLength(1);
    expect(state.fetchCalls).toBe(0); // guarded BEFORE any request
    const log = (await fireLogs.listFireLogsByTrigger(trigger.id, 1))[0];
    expect(log).toMatchObject({ outcome: "error" });
    expect(log!.detail).toContain("blocked address");
    expect((await triggers.getTrigger(trigger.id))?.circuit.consecutiveFailures).toBe(1);
  });

  it("refuses an oversized feed body (1 MiB cap)", async () => {
    const { deps, fireLogs, trigger } = await setup({
      body: `<rss><channel><item><guid>g</guid></item>${"x".repeat(RSS_MAX_RESPONSE_BYTES)}</channel></rss>`,
    });
    const summary = await runRssPollSweep(deps, at(0));
    expect(summary.errors).toHaveLength(1);
    const log = (await fireLogs.listFireLogsByTrigger(trigger.id, 1))[0];
    expect(log!.detail).toContain("response cap");
  });

  it("a non-2xx feed → error fire log; polledAt still advances (retry next interval, not next sweep)", async () => {
    const { deps, triggers, trigger } = await setup({ status: 503 });
    // Seed an existing cursor so the failure path advances polledAt.
    await triggers.updateCursor(
      trigger.id,
      JSON.stringify({ v: 1, polledAt: at(-10), seen: ["post-1", "post-2"] }),
    );
    const summary = await runRssPollSweep(deps, at(0));
    expect(summary.errors).toHaveLength(1);
    expect((await cursorOf(triggers, trigger.id)).polledAt).toBe(at(0));
    // Not due again 1 minute later (interval 5).
    const retry = await runRssPollSweep(deps, at(1));
    expect(retry.processed).toBe(0);
  });

  it("enforces the 5-minute interval FLOOR even when a raw record carries less", async () => {
    const { deps, dispatcher, state } = await setup({ config: { intervalMinutes: 1 } });
    await runRssPollSweep(deps, at(0)); // baseline
    state.body = RSS2_FIXTURE.replace(
      "<item>",
      `<item><guid>post-3</guid><title>Three</title></item><item>`,
    );
    const early = await runRssPollSweep(deps, at(2)); // < 5 min — clamped, not due
    expect(early.processed).toBe(0);
    const due = await runRssPollSweep(deps, at(5));
    expect(due.dispatched).toBe(1);
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("one broken feed never kills the sweep for other triggers (isolation)", async () => {
    const { deps, triggers, state } = await setup({ resolveTo: ["10.0.0.8"] });
    // Second trigger on the same (blocked) sweep run — still isolated per trigger:
    // here we prove the loop continues by observing the second trigger baseline.
    const second = triggers.seed(makeRssTrigger({ id: "rss-2" }));
    const summary = await runRssPollSweep(deps, at(0));
    expect(summary.processed).toBe(2);
    expect(summary.errors).toHaveLength(2); // both blocked — but BOTH were attempted
    expect(state.fetchCalls).toBe(0);
    expect((await triggers.getTrigger(second.id))?.circuit.consecutiveFailures).toBe(1);
  });
});
