// The Forge Automations card + its Auto deep-link contract.
//
// The `?template=` encoding must be byte-for-byte the one Market ships
// (apps/market-web/lib/automation-template-link.ts) and the payload must be
// the exact shape Auto's wizard decoder accepts (apps/auto-web
// lib/automations/template-link.ts) — so both reference implementations are
// imported directly and asserted against.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildAutomationTemplateLink,
  buildForgeAutomationsCardModel,
  describeAutomationTrigger,
  encodeAutomationTemplateParam,
  type ForgeAutomationTemplate,
  type ForgeKitAutomation
} from "../app/forge/sections/kit-automations";
import { AutomationsCard } from "../app/forge/sections/AutomationsCard";
// Reference implementations (read-only imports across apps):
import { encodeAutomationTemplateParam as marketEncode } from "../../market-web/lib/automation-template-link";
import { decodeTemplateParam as autoDecode } from "../../auto-web/lib/automations/template-link";

const SCHEDULE_AUTOMATION: ForgeKitAutomation = {
  name: "Daily financial summary",
  description: "Summarize yesterday's transactions.",
  trigger: { type: "schedule", config: { cron: "0 9 * * *", timezone: "America/New_York" } },
  promptTemplate: "Summarize the last 24 hours of transactions."
};

const EVENT_AUTOMATION: ForgeKitAutomation = {
  name: "New invoice triage",
  trigger: { type: "event", config: { eventName: "invoice.received" } },
  promptTemplate: "Triage the incoming invoice."
};

const AUTO_URL = "https://auto.agentkitproject.com";

describe("encodeAutomationTemplateParam", () => {
  it("matches Market's encoder byte-for-byte for the same input", () => {
    const templates: ForgeAutomationTemplate[] = [
      {
        name: SCHEDULE_AUTOMATION.name,
        trigger: SCHEDULE_AUTOMATION.trigger,
        mapping: { promptTemplate: SCHEDULE_AUTOMATION.promptTemplate },
        kitRef: { source: "local", localKitId: "kit-abc123" }
      },
      {
        // Non-ASCII exercises the UTF-8 → base64url path (btoa vs Buffer).
        name: "Überwachung — 監視 ✓",
        trigger: { type: "event" },
        mapping: { promptTemplate: "Prüfe alle Rechnungen ≥ 100 €." },
        kitRef: { source: "market", marketKitId: "mk-1", slug: "watcher" }
      }
    ];

    for (const template of templates) {
      // Market's AutomationTemplate types kitRef as `market:<slug>` string;
      // the encoders are shape-agnostic JSON serializers, so the byte-for-byte
      // claim is asserted on identical inputs regardless of kitRef form.
      expect(encodeAutomationTemplateParam(template)).toBe(
        marketEncode(template as unknown as Parameters<typeof marketEncode>[0])
      );
    }
  });

  it("emits URL-safe base64url (no +, /, =)", () => {
    const encoded = encodeAutomationTemplateParam({
      name: "x?>>>~~~",
      trigger: { type: "schedule" },
      mapping: { promptTemplate: "y".repeat(100) },
      kitRef: { source: "local", localKitId: "kit-1" }
    });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("buildAutomationTemplateLink / card model", () => {
  it("builds `${autoBaseUrl}/?template=` links Auto's wizard decoder accepts with a local kitRef", () => {
    const [item] = buildForgeAutomationsCardModel({
      automations: [SCHEDULE_AUTOMATION],
      kitId: "kit-abc123",
      autoBaseUrl: AUTO_URL
    });

    expect(item.enableHref).toBeDefined();
    expect(item.enableHref!.startsWith(`${AUTO_URL}/?template=`)).toBe(true);

    // Decode with Auto's ACTUAL consumer — proves the wizard opens prefilled.
    const param = item.enableHref!.split("?template=")[1];
    const decoded = autoDecode(param);
    expect(decoded).not.toBeNull();
    expect(decoded!.name).toBe("Daily financial summary");
    expect(decoded!.trigger).toEqual({
      type: "schedule",
      config: { cron: "0 9 * * *", timezone: "America/New_York" }
    });
    expect(decoded!.mapping.promptTemplate).toBe("Summarize the last 24 hours of transactions.");
    // The local object form — what TriggerWizard resolves against the shared
    // kit store (k.kitId === kitRef.localKitId).
    expect(decoded!.kitRef).toEqual({ source: "local", localKitId: "kit-abc123" });
  });

  it("trims trailing slashes off the Auto base URL", () => {
    const href = buildAutomationTemplateLink({
      autoBaseUrl: `${AUTO_URL}///`,
      template: {
        name: "n",
        trigger: { type: "event" },
        mapping: { promptTemplate: "p" },
        kitRef: { source: "local", localKitId: "kit-1" }
      }
    });
    expect(href.startsWith(`${AUTO_URL}/?template=`)).toBe(true);
  });

  it("omits enableHref when no Auto URL is configured (self-host without Auto)", () => {
    const [item] = buildForgeAutomationsCardModel({
      automations: [EVENT_AUTOMATION],
      kitId: "kit-1"
    });
    expect(item.enableHref).toBeUndefined();
    expect(item.triggerLabel).toBe('When "invoice.received" arrives');
  });

  it("previews long prompts truncated with an ellipsis", () => {
    const [item] = buildForgeAutomationsCardModel({
      automations: [{ ...EVENT_AUTOMATION, promptTemplate: "z".repeat(500) }],
      kitId: "kit-1"
    });
    expect(item.promptPreview.length).toBe(161);
    expect(item.promptPreview.endsWith("…")).toBe(true);
  });
});

describe("describeAutomationTrigger", () => {
  it("summarizes daily, weekly, opaque cron, and event triggers", () => {
    expect(describeAutomationTrigger(SCHEDULE_AUTOMATION.trigger)).toBe(
      "Daily at 9:00 (America/New_York)"
    );
    expect(
      describeAutomationTrigger({ type: "schedule", config: { cron: "30 17 * * 1" } })
    ).toBe("Weekly on Monday at 17:30");
    expect(
      describeAutomationTrigger({ type: "schedule", config: { cron: "*/5 * * * *" } })
    ).toBe("On a schedule (*/5 * * * *)");
    expect(describeAutomationTrigger({ type: "schedule" })).toBe("On a schedule");
    expect(describeAutomationTrigger({ type: "event" })).toBe("When an event arrives");
  });
});

describe("AutomationsCard", () => {
  it("renders name, trigger summary, prompt preview, and the Enable in Auto href", () => {
    const html = renderToStaticMarkup(
      createElement(AutomationsCard, {
        automations: [SCHEDULE_AUTOMATION, EVENT_AUTOMATION],
        kitId: "kit-abc123",
        autoBaseUrl: AUTO_URL
      })
    );

    expect(html).toContain("Automations");
    expect(html).toContain("Daily financial summary");
    expect(html).toContain("Daily at 9:00 (America/New_York)");
    expect(html).toContain("Summarize the last 24 hours of transactions.");
    expect(html).toContain("Enable in Auto");

    const [expectedHref] = buildForgeAutomationsCardModel({
      automations: [SCHEDULE_AUTOMATION],
      kitId: "kit-abc123",
      autoBaseUrl: AUTO_URL
    }).map((i) => i.enableHref);
    expect(html).toContain(`href="${expectedHref}"`);
  });

  it("renders entries without the link when no Auto URL is configured", () => {
    const html = renderToStaticMarkup(
      createElement(AutomationsCard, {
        automations: [EVENT_AUTOMATION],
        kitId: "kit-1"
      })
    );
    expect(html).toContain("New invoice triage");
    expect(html).not.toContain("Enable in Auto");
    expect(html).not.toContain("href=");
  });

  it("renders nothing when the kit declares no automations", () => {
    const html = renderToStaticMarkup(
      createElement(AutomationsCard, { automations: [], kitId: "kit-1", autoBaseUrl: AUTO_URL })
    );
    expect(html).toBe("");
  });
});
