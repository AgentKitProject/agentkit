/**
 * Email-in poller tests (Wave 4): tolerant MIME parsing (plain / multipart /
 * quoted-printable / base64 / encoded-words / malformed→skip), TO-address
 * routing, sender allowlist (explicit + owner-only fail-closed), body
 * truncation, baseline first sweep, seen-set no-dupe, per-sweep caps, and the
 * IMAP / unconfigured clean skips.
 */

import { describe, expect, it } from "vitest";
import {
  EMAIL_IN_MAX_EVENTS_PER_SWEEP,
  parseInboundEmail,
  runEmailInPollSweep,
  type EmailInPollDeps,
  type EmailInboxConfig,
  type InboxObjectSummary,
} from "../src/core/email-in-poller.js";
import { EMAIL_IN_BODY_MAX_CHARS } from "../src/core/types.js";
import type { KitRef, Trigger } from "../src/core/types.js";
import type { CreateAndDispatchTriggerRun } from "../src/core/trigger-runner.js";
import { InMemoryApprovalRepo } from "./approval-repo-fake.js";
import { fakeCanStart, InMemoryFireLogRepo, InMemoryTriggerRepo } from "./fakes.js";

const KIT: KitRef = { source: "local", localKitId: "k1" };
const NOW = "2026-07-03T12:00:00.000Z";
const LATER = "2026-07-03T12:05:00.000Z";
const INBOX: EmailInboxConfig = { bucket: "inbox", prefix: "mail/", domain: "in.example.com" };

// ---------------------------------------------------------------------------
// MIME parsing
// ---------------------------------------------------------------------------

describe("parseInboundEmail", () => {
  it("parses a plain text message (From/To/Subject/Date + body)", () => {
    const raw = [
      "From: Boss <boss@example.com>",
      "To: kit-abc@in.example.com",
      "Subject: Weekly report",
      "Date: Thu, 03 Jul 2026 10:00:00 +0000",
      "",
      "Please summarize the week.",
      "Thanks.",
    ].join("\r\n");
    const email = parseInboundEmail(raw);
    expect(email).not.toBeNull();
    expect(email!.from).toBe("boss@example.com");
    expect(email!.to).toEqual(["kit-abc@in.example.com"]);
    expect(email!.subject).toBe("Weekly report");
    expect(email!.bodyText).toBe("Please summarize the week.\nThanks.");
  });

  it("picks the text/plain part of a first-level multipart and decodes QP", () => {
    const raw = [
      "From: a@example.com",
      "To: kit-abc@in.example.com",
      "Subject: Multi",
      'Content-Type: multipart/alternative; boundary="BOUND"',
      "",
      "preamble",
      "--BOUND",
      "Content-Type: text/html",
      "",
      "<b>nope</b>",
      "--BOUND",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Line one =E2=9C=93 soft=",
      "break",
      "--BOUND--",
    ].join("\r\n");
    const email = parseInboundEmail(raw);
    expect(email!.bodyText).toBe("Line one ✓ softbreak");
  });

  it("decodes base64 bodies and RFC 2047 encoded-word subjects", () => {
    const raw = [
      "From: a@example.com",
      "To: kit-abc@in.example.com",
      `Subject: =?utf-8?B?${Buffer.from("Grüße").toString("base64")}?=`,
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("decoded body").toString("base64"),
    ].join("\n");
    const email = parseInboundEmail(raw);
    expect(email!.subject).toBe("Grüße");
    expect(email!.bodyText).toBe("decoded body");
  });

  it("unfolds folded headers and collects every To address", () => {
    const raw = [
      "From: a@example.com",
      "To: one@example.com,",
      " kit-abc@in.example.com",
      "Subject: folded",
      "",
      "hi",
    ].join("\n");
    const email = parseInboundEmail(raw);
    expect(email!.to).toEqual(["one@example.com", "kit-abc@in.example.com"]);
  });

  it("truncates the body to EMAIL_IN_BODY_MAX_CHARS", () => {
    const raw = `From: a@example.com\nTo: b@in.example.com\nSubject: big\n\n${"x".repeat(
      EMAIL_IN_BODY_MAX_CHARS + 100,
    )}`;
    const email = parseInboundEmail(raw);
    expect(email!.bodyText.length).toBeLessThanOrEqual(EMAIL_IN_BODY_MAX_CHARS + 20);
    expect(email!.bodyText.endsWith("…[truncated]")).toBe(true);
  });

  it("returns null for malformed input (no headers / no addresses / empty)", () => {
    expect(parseInboundEmail("")).toBeNull();
    expect(parseInboundEmail("just some text without headers")).toBeNull();
    expect(parseInboundEmail("Subject: no addresses\n\nbody")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

function makeEmailTrigger(over: Partial<Trigger> = {}): Trigger {
  return {
    id: "trig-email",
    userId: "u1",
    name: "email in",
    type: "email_in",
    config: { address: "kit-abc@in.example.com", addressSlug: "kit-abc", allowedFrom: [], connectionId: null },
    kitRef: KIT,
    approvalId: "appr-1",
    budgetCents: 100,
    mapping: { promptTemplate: "Handle {{subject}}", attachPayloadAs: "event.json", fileHandling: "attach" },
    rateLimit: { maxPerHour: 100 },
    enabled: true,
    cursor: null,
    circuit: { consecutiveFailures: 0, pausedAt: null },
    createdAt: NOW,
    updatedAt: NOW,
    fireCount: 0,
    ...over,
  } as Trigger;
}

function rawMail(from: string, to: string, subject: string, body = "hello"): string {
  return `From: ${from}\nTo: ${to}\nSubject: ${subject}\n\n${body}`;
}

interface SweepSetupOptions {
  trigger?: Partial<Trigger>;
  objects?: Record<string, string>; // key → raw MIME
  ownerEmail?: string | undefined;
  inbox?: EmailInboxConfig | undefined;
}

function setup(options: SweepSetupOptions = {}) {
  const triggers = new InMemoryTriggerRepo();
  const approvals = new InMemoryApprovalRepo();
  const fireLogs = new InMemoryFireLogRepo();
  const objects = options.objects ?? {};
  const dispatched: unknown[] = [];
  const createAndDispatch: CreateAndDispatchTriggerRun = async (req) => {
    dispatched.push(req.input);
    return {
      id: `run-${dispatched.length}`,
      userId: req.trigger.userId,
      kitRef: req.trigger.kitRef,
      status: "queued",
      input: req.input,
      budgetCents: 100,
      spentCents: 0,
      model: "m",
      createdAt: req.firedAt,
      auditLog: [],
    };
  };
  const trigger = triggers.seed(makeEmailTrigger(options.trigger));
  const deps: EmailInPollDeps = {
    triggers,
    approvals,
    fireLogs,
    canStartRun: fakeCanStart(true).fn,
    createAndDispatch,
    inbox: "inbox" in options ? options.inbox : INBOX,
    listInbox: async (): Promise<InboxObjectSummary[]> =>
      Object.keys(objects).map((key, i) => ({
        key,
        lastModified: new Date(Date.parse(NOW) - 1000 + i).toISOString(),
      })),
    getInboxObject: async ({ key }) => {
      const raw = objects[key];
      if (raw === undefined) throw new Error("missing object");
      return raw;
    },
    ...(options.ownerEmail !== undefined
      ? { getOwnerEmail: async () => options.ownerEmail }
      : {}),
  };
  return { triggers, approvals, fireLogs, dispatched, trigger, deps };
}

async function seedApproval(setupResult: ReturnType<typeof setup>): Promise<void> {
  await setupResult.approvals.createApproval({
    userId: "u1",
    kitRef: KIT,
    toolAllowlist: [],
    maxBudgetCents: 1000,
    createdAt: NOW,
  });
}

/** First sweep baselines; run a second sweep at LATER with fresh objects. */
async function baselineThen(
  s: ReturnType<typeof setup>,
  addObjects: Record<string, string>,
  objects: Record<string, string>,
) {
  await runEmailInPollSweep(s.deps, NOW); // baseline (no events)
  Object.assign(objects, addObjects);
  return runEmailInPollSweep(s.deps, LATER);
}

describe("runEmailInPollSweep", () => {
  it("baselines the first sweep (no event storm) and fires only NEW mail addressed to the trigger", async () => {
    const objects: Record<string, string> = {
      "mail/old": rawMail("owner@example.com", "kit-abc@in.example.com", "old"),
    };
    const s = setup({ objects, ownerEmail: "owner@example.com" });
    await seedApproval(s);

    const first = await runEmailInPollSweep(s.deps, NOW);
    expect(first.dispatched).toBe(0); // baseline
    expect(s.dispatched.length).toBe(0);

    objects["mail/new"] = rawMail("owner@example.com", "kit-abc@in.example.com", "fresh news");
    const second = await runEmailInPollSweep(s.deps, LATER);
    expect(second.dispatched).toBe(1);
    const input = s.dispatched[0] as { prompt: string };
    expect(input.prompt).toBe("Handle fresh news"); // S1: template + data value

    // Third sweep: nothing new → no dupes.
    const third = await runEmailInPollSweep(s.deps, "2026-07-03T12:10:00.000Z");
    expect(third.dispatched).toBe(0);
  });

  it("routes by TO address: mail for other slugs is ignored silently", async () => {
    const objects: Record<string, string> = {};
    const s = setup({ objects, ownerEmail: "owner@example.com" });
    await seedApproval(s);
    const summary = await baselineThen(
      s,
      { "mail/other": rawMail("owner@example.com", "someone-else@in.example.com", "not ours") },
      objects,
    );
    expect(summary.dispatched).toBe(0);
    expect(await s.fireLogs.listFireLogsByTrigger("trig-email", 10)).toEqual([]);
  });

  it("explicit allowedFrom: non-matching sender → fire-log 'filtered', no run", async () => {
    const objects: Record<string, string> = {};
    const s = setup({
      objects,
      trigger: {
        config: { address: null, addressSlug: "kit-abc", allowedFrom: ["boss@example.com"], connectionId: null },
      } as Partial<Trigger>,
    });
    await seedApproval(s);
    const summary = await baselineThen(
      s,
      {
        "mail/spam": rawMail("attacker@evil.example", "kit-abc@in.example.com", "ignore me"),
        "mail/ok": rawMail("BOSS@example.com", "kit-abc@in.example.com", "do it"),
      },
      objects,
    );
    expect(summary.dispatched).toBe(1);
    const logs = await s.fireLogs.listFireLogsByTrigger("trig-email", 10);
    const filtered = logs.filter((l) => l.outcome === "filtered");
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.detail).toContain("attacker@evil.example");
  });

  it("empty allowlist FAILS CLOSED when the owner email cannot be resolved", async () => {
    const objects: Record<string, string> = {};
    const s = setup({ objects }); // no getOwnerEmail seam wired
    await seedApproval(s);
    const summary = await baselineThen(
      s,
      { "mail/x": rawMail("someone@example.com", "kit-abc@in.example.com", "hi") },
      objects,
    );
    expect(summary.dispatched).toBe(0);
    const logs = await s.fireLogs.listFireLogsByTrigger("trig-email", 10);
    expect(logs[0]!.outcome).toBe("filtered");
  });

  it("malformed MIME is skipped (marked seen; no event, no error)", async () => {
    const objects: Record<string, string> = {};
    const s = setup({ objects, ownerEmail: "owner@example.com" });
    await seedApproval(s);
    const summary = await baselineThen(s, { "mail/garbage": "not an email at all" }, objects);
    expect(summary.dispatched).toBe(0);
    expect(summary.errors).toEqual([]);
    // Not re-examined next sweep (seen).
    const next = await runEmailInPollSweep(s.deps, "2026-07-03T12:10:00.000Z");
    expect(next.dispatched).toBe(0);
  });

  it("caps dispatches per sweep and picks the remainder up next sweep (no-miss)", async () => {
    const objects: Record<string, string> = {};
    const s = setup({ objects, ownerEmail: "owner@example.com" });
    await seedApproval(s);
    const fresh: Record<string, string> = {};
    for (let i = 0; i < EMAIL_IN_MAX_EVENTS_PER_SWEEP + 3; i++) {
      fresh[`mail/m${String(i).padStart(3, "0")}`] = rawMail(
        "owner@example.com",
        "kit-abc@in.example.com",
        `msg ${i}`,
      );
    }
    const summary = await baselineThen(s, fresh, objects);
    expect(summary.dispatched).toBe(EMAIL_IN_MAX_EVENTS_PER_SWEEP);
    const next = await runEmailInPollSweep(s.deps, "2026-07-03T12:10:00.000Z");
    expect(next.dispatched).toBe(3);
  });

  it("IMAP-shaped triggers (connectionId) and an unconfigured inbox skip cleanly", async () => {
    // IMAP config → clean skip, no error, no circuit.
    const imap = setup({
      trigger: {
        config: { address: null, addressSlug: null, allowedFrom: [], connectionId: "conn-imap" },
      } as Partial<Trigger>,
    });
    const imapSummary = await runEmailInPollSweep(imap.deps, NOW);
    expect(imapSummary.errors).toEqual([]);
    expect(imapSummary.skipped).toBe(1);

    // No inbox env → inert.
    const inert = setup({ inbox: undefined });
    const inertSummary = await runEmailInPollSweep(inert.deps, NOW);
    expect(inertSummary.errors).toEqual([]);
    expect(inertSummary.skipped).toBe(1);
    expect((await inert.triggers.getTrigger("trig-email"))!.cursor).toBeNull();
  });

  it("a listing failure records an error fire log + circuit failure (poll-level)", async () => {
    const s = setup({ ownerEmail: "owner@example.com" });
    await seedApproval(s);
    s.deps.listInbox = async () => {
      throw new Error("s3 unavailable");
    };
    const summary = await runEmailInPollSweep(s.deps, NOW);
    expect(summary.errors.length).toBe(1);
    const logs = await s.fireLogs.listFireLogsByTrigger("trig-email", 10);
    expect(logs[0]!.outcome).toBe("error");
    expect((await s.triggers.getTrigger("trig-email"))!.circuit.consecutiveFailures).toBe(1);
  });
});
