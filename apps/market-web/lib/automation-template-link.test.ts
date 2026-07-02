import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAutomationTemplateLink,
  decodeAutomationTemplateParam,
  encodeAutomationTemplateParam,
  type AutomationTemplate
} from "./automation-template-link.ts";

const scheduleTemplate: AutomationTemplate = {
  name: "Daily financial summary",
  trigger: {
    type: "schedule",
    config: { cron: "0 9 * * *", timezone: "America/New_York" }
  },
  mapping: {
    promptTemplate: "Summarize the last 24 hours of transactions & highlight anomalies?"
  },
  kitRef: "market:financial-review"
};

const eventTemplate: AutomationTemplate = {
  name: "New invoice triage",
  trigger: { type: "event", config: { eventName: "invoice.received" } },
  mapping: { promptTemplate: "Triage the incoming invoice." },
  kitRef: "market:invoice-kit"
};

describe("buildAutomationTemplateLink", () => {
  it("builds `${autoBaseUrl}/?template=<base64url(JSON)>`", () => {
    const link = buildAutomationTemplateLink({
      autoBaseUrl: "https://auto.agentkitproject.com",
      template: scheduleTemplate
    });

    const expectedParam = Buffer.from(JSON.stringify(scheduleTemplate), "utf8").toString("base64url");
    assert.equal(link, `https://auto.agentkitproject.com/?template=${expectedParam}`);
  });

  it("normalizes trailing slashes on the Auto base URL", () => {
    const link = buildAutomationTemplateLink({
      autoBaseUrl: "https://auto.example.com///",
      template: eventTemplate
    });

    assert.match(link, /^https:\/\/auto\.example\.com\/\?template=/);
  });

  it("produces a URL-safe param (no +, /, =, or raw JSON characters)", () => {
    const link = buildAutomationTemplateLink({
      autoBaseUrl: "https://auto.agentkitproject.com",
      template: scheduleTemplate
    });
    const param = new URL(link).searchParams.get("template");

    assert.ok(param);
    assert.match(param, /^[A-Za-z0-9_-]+$/);
  });

  it("round-trips encode → decode losslessly for schedule and event templates", () => {
    for (const template of [scheduleTemplate, eventTemplate]) {
      const link = buildAutomationTemplateLink({
        autoBaseUrl: "https://auto.agentkitproject.com",
        template
      });
      const param = new URL(link).searchParams.get("template");

      assert.ok(param);
      assert.deepEqual(decodeAutomationTemplateParam(param), template);
    }
  });

  it("round-trips a template without trigger config", () => {
    const template: AutomationTemplate = {
      name: "Minimal",
      trigger: { type: "schedule" },
      mapping: { promptTemplate: "Do the thing." },
      kitRef: "market:minimal-kit"
    };

    assert.deepEqual(
      decodeAutomationTemplateParam(encodeAutomationTemplateParam(template)),
      template
    );
  });

  it("decode rejects garbage and payloads missing required fields", () => {
    assert.throws(() => decodeAutomationTemplateParam("%%%not-base64url%%%"));
    assert.throws(() =>
      decodeAutomationTemplateParam(Buffer.from("\"just a string\"").toString("base64url"))
    );
    assert.throws(() =>
      decodeAutomationTemplateParam(
        Buffer.from(
          JSON.stringify({ name: "x", trigger: { type: "webhook" }, mapping: { promptTemplate: "y" }, kitRef: "z" })
        ).toString("base64url")
      )
    );
    assert.throws(() =>
      decodeAutomationTemplateParam(
        Buffer.from(
          JSON.stringify({ name: "x", trigger: { type: "schedule" }, kitRef: "market:x" })
        ).toString("base64url")
      )
    );
  });

  it("the payload carries only the suggestion fields — never approvals or destinations", () => {
    const link = buildAutomationTemplateLink({
      autoBaseUrl: "https://auto.agentkitproject.com",
      template: scheduleTemplate
    });
    const param = new URL(link).searchParams.get("template");
    const decodedJson = Buffer.from(param ?? "", "base64url").toString("utf8");

    assert.deepEqual(Object.keys(JSON.parse(decodedJson)).sort(), [
      "kitRef",
      "mapping",
      "name",
      "trigger"
    ]);
    assert.doesNotMatch(decodedJson, /approval|budget|destination|connection|token|secret/i);
  });
});
