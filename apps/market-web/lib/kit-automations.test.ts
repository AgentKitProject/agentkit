import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { decodeAutomationTemplateParam } from "./automation-template-link.ts";
import {
  buildKitAutomationsCardModel,
  describeAutomationTrigger,
  normalizeKitAutomations
} from "./kit-automations.ts";
import { normalizeKitDetail } from "./market-api.ts";

const scheduleAutomation = {
  name: "Daily financial summary",
  description: "Summarize yesterday's transactions.",
  trigger: { type: "schedule", config: { cron: "0 9 * * *", timezone: "America/New_York" } },
  promptTemplate: "Summarize the last 24 hours of transactions."
};

const eventAutomation = {
  name: "New invoice triage",
  trigger: { type: "event", config: { eventName: "invoice.received" } },
  promptTemplate: "Triage the incoming invoice."
};

describe("normalizeKitAutomations", () => {
  it("keeps well-formed schedule and event entries", () => {
    const automations = normalizeKitAutomations([scheduleAutomation, eventAutomation]);

    assert.equal(automations.length, 2);
    assert.equal(automations[0].trigger.type, "schedule");
    assert.equal(automations[0].trigger.config?.cron, "0 9 * * *");
    assert.equal(automations[1].trigger.config?.eventName, "invoice.received");
  });

  it("returns [] for absent or non-array payloads", () => {
    assert.deepEqual(normalizeKitAutomations(undefined), []);
    assert.deepEqual(normalizeKitAutomations("nope"), []);
    assert.deepEqual(normalizeKitAutomations({}), []);
  });

  it("drops malformed entries (missing promptTemplate, bad trigger type)", () => {
    const automations = normalizeKitAutomations([
      { name: "No prompt", trigger: { type: "schedule" } },
      { name: "Bad trigger", trigger: { type: "webhook" }, promptTemplate: "x" },
      eventAutomation
    ]);

    assert.equal(automations.length, 1);
    assert.equal(automations[0].name, "New invoice triage");
  });

  it("never carries unknown keys through (no approvals/budgets/destinations/connections)", () => {
    const automations = normalizeKitAutomations([
      {
        ...scheduleAutomation,
        approvalId: "smuggled",
        destinations: ["slack://finance"],
        trigger: { type: "schedule", config: { cron: "0 9 * * *", connectionId: "conn_1" } }
      }
    ]);

    assert.equal(automations.length, 1);
    const serialized = JSON.stringify(automations);
    assert.doesNotMatch(serialized, /approvalId|destinations|connectionId|smuggled|slack/);
  });

  it("caps the list at 10 entries", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      ...scheduleAutomation,
      name: `Automation ${index + 1}`
    }));

    assert.equal(normalizeKitAutomations(many).length, 10);
  });
});

describe("describeAutomationTrigger", () => {
  it("summarizes daily and weekly cron schedules in plain language", () => {
    assert.equal(
      describeAutomationTrigger({ type: "schedule", config: { cron: "0 9 * * *" } }),
      "Daily at 9:00"
    );
    assert.equal(
      describeAutomationTrigger({ type: "schedule", config: { cron: "30 17 * * 1" } }),
      "Weekly on Monday at 17:30"
    );
    assert.equal(
      describeAutomationTrigger({
        type: "schedule",
        config: { cron: "0 9 * * *", timezone: "America/New_York" }
      }),
      "Daily at 9:00 (America/New_York)"
    );
  });

  it("falls back gracefully for uncommon or missing cron expressions", () => {
    assert.equal(
      describeAutomationTrigger({ type: "schedule", config: { cron: "*/5 * * * *" } }),
      "On a schedule (*/5 * * * *)"
    );
    assert.equal(describeAutomationTrigger({ type: "schedule" }), "On a schedule");
  });

  it("summarizes event triggers", () => {
    assert.equal(
      describeAutomationTrigger({ type: "event", config: { eventName: "invoice.received" } }),
      'When "invoice.received" arrives'
    );
    assert.equal(describeAutomationTrigger({ type: "event" }), "When an event arrives");
  });
});

describe("buildKitAutomationsCardModel", () => {
  const automations = normalizeKitAutomations([scheduleAutomation, eventAutomation]);

  it("builds Enable-in-Auto links with the template param and market: kitRef", () => {
    const items = buildKitAutomationsCardModel({
      automations,
      slug: "financial-review",
      autoBaseUrl: "https://auto.agentkitproject.com"
    });

    assert.equal(items.length, 2);
    assert.equal(items[0].triggerLabel, "Daily at 9:00 (America/New_York)");
    assert.ok(items[0].enableHref?.startsWith("https://auto.agentkitproject.com/?template="));

    const param = new URL(items[0].enableHref ?? "").searchParams.get("template");
    const template = decodeAutomationTemplateParam(param ?? "");
    assert.equal(template.name, "Daily financial summary");
    assert.equal(template.kitRef, "market:financial-review");
    assert.equal(template.trigger.type, "schedule");
    assert.deepEqual(template.trigger.config, { cron: "0 9 * * *", timezone: "America/New_York" });
    assert.equal(template.mapping.promptTemplate, scheduleAutomation.promptTemplate);
  });

  it("omits the link when no Auto URL is configured (self-host without Auto)", () => {
    const items = buildKitAutomationsCardModel({
      automations,
      slug: "financial-review",
      autoBaseUrl: undefined
    });

    assert.equal(items.length, 2);
    assert.equal(items[0].enableHref, undefined);
    assert.equal(items[0].triggerLabel, "Daily at 9:00 (America/New_York)");
  });
});

describe("kit-detail plumbing and Automations card", () => {
  it("normalizeKitDetail surfaces automations when the backend payload carries them", () => {
    const detail = normalizeKitDetail({
      slug: "financial-review",
      name: "Financial Review",
      automations: [scheduleAutomation, { ...eventAutomation, approvalId: "smuggled" }]
    });

    assert.equal(detail.automations?.length, 2);
    assert.doesNotMatch(JSON.stringify(detail.automations), /approvalId|smuggled/);
  });

  it("normalizeKitDetail degrades gracefully when the payload has no automations", () => {
    const detail = normalizeKitDetail({ slug: "plain-kit", name: "Plain Kit" });

    assert.equal(detail.automations, undefined);
  });

  it("the Automations card renders name, trigger summary, and Enable in Auto", async () => {
    const source = await readFile(new URL("../components/KitAutomationsCard.tsx", import.meta.url), "utf8");

    assert.match(source, /Automations/);
    assert.match(source, /buildKitAutomationsCardModel/);
    assert.match(source, /triggerLabel/);
    assert.match(source, /Enable in Auto/);
    // Renders nothing when the kit has no automations.
    assert.match(source, /return null/);
    // Suggestions never carry approval/budget/destination/connection fields.
    assert.doesNotMatch(source, /approvalId|budgetUsd|destinationId|connectionId/);
  });

  it("the kit detail page wires the card to the kit payload and the Auto app URL", async () => {
    const source = await readFile(new URL("../app/kits/[slug]/page.tsx", import.meta.url), "utf8");

    assert.match(source, /KitAutomationsCard/);
    assert.match(source, /automations=\{kit\.automations\}/);
    assert.match(source, /autoBaseUrl=\{getAutoWebUrl\(\)\}/);
  });
});
