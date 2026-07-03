/**
 * The ?template= deep-link contract (lib/automations/template-link.ts):
 * base64url JSON of { name, trigger: { type, config? }, mapping:
 * { promptTemplate }, kitRef? }. Market builds links to THIS exact contract;
 * decode must be defensive — garbage yields null, never a throw.
 */
import { describe, expect, it } from "vitest";
import {
  decodeTemplateParam,
  encodeTemplateParam,
  type AutomationTemplate
} from "@/lib/automations/template-link";

const VALID: AutomationTemplate = {
  name: "Daily digest",
  trigger: { type: "schedule", config: { cron: "0 9 * * *", timezone: "America/New_York" } },
  mapping: { promptTemplate: "Compile the daily digest for {{repo.name}}." },
  kitRef: { source: "local", localKitId: "kit-1" }
};

describe("encode/decode round trip", () => {
  it("round-trips a full template (schedule + kitRef)", () => {
    expect(decodeTemplateParam(encodeTemplateParam(VALID))).toEqual(VALID);
  });

  it("round-trips an event template without kitRef or config", () => {
    const t: AutomationTemplate = {
      name: "On new issue",
      trigger: { type: "event" },
      mapping: { promptTemplate: "Triage {{issue.title}}." }
    };
    expect(decodeTemplateParam(encodeTemplateParam(t))).toEqual(t);
  });

  it("round-trips a market kitRef and non-ASCII text (base64url, UTF-8)", () => {
    const t: AutomationTemplate = {
      name: "Résumé — überwachen 監視",
      trigger: { type: "rss", config: { feedUrl: "https://example.com/feed.xml" } },
      mapping: { promptTemplate: "Summarize “{{title}}” 📰" },
      kitRef: { source: "market", marketKitId: "mk-1", slug: "watcher" }
    };
    const encoded = encodeTemplateParam(t);
    expect(encoded).not.toMatch(/[+/=]/); // base64url, unpadded
    // Decoding validates config through the contracts schema, which fills the
    // Wave-3b rss default (intervalMinutes 15).
    expect(decodeTemplateParam(encoded)).toEqual({
      ...t,
      trigger: {
        type: "rss",
        config: { feedUrl: "https://example.com/feed.xml", intervalMinutes: 15 }
      }
    });
  });
});

describe("defensive decoding — garbage → null, never a throw", () => {
  const b64url = (s: string) =>
    Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  it("null/empty/missing param", () => {
    expect(decodeTemplateParam(null)).toBeNull();
    expect(decodeTemplateParam(undefined)).toBeNull();
    expect(decodeTemplateParam("")).toBeNull();
  });

  it("not base64 / not JSON / not an object", () => {
    expect(decodeTemplateParam("!!!not-base64!!!")).toBeNull();
    expect(decodeTemplateParam(b64url("not json at all"))).toBeNull();
    expect(decodeTemplateParam(b64url('"just a string"'))).toBeNull();
    expect(decodeTemplateParam(b64url("[1,2,3]"))).toBeNull();
  });

  it("missing / invalid name", () => {
    expect(decodeTemplateParam(b64url(JSON.stringify({ ...VALID, name: undefined })))).toBeNull();
    expect(decodeTemplateParam(b64url(JSON.stringify({ ...VALID, name: "   " })))).toBeNull();
    expect(decodeTemplateParam(b64url(JSON.stringify({ ...VALID, name: "x".repeat(81) })))).toBeNull();
  });

  it("unknown trigger type / missing trigger", () => {
    expect(decodeTemplateParam(b64url(JSON.stringify({ ...VALID, trigger: { type: "quantum" } })))).toBeNull();
    expect(decodeTemplateParam(b64url(JSON.stringify({ ...VALID, trigger: undefined })))).toBeNull();
  });

  it("missing / oversized promptTemplate (S1: the template IS the instructions)", () => {
    expect(decodeTemplateParam(b64url(JSON.stringify({ ...VALID, mapping: {} })))).toBeNull();
    expect(
      decodeTemplateParam(b64url(JSON.stringify({ ...VALID, mapping: { promptTemplate: "x".repeat(4001) } })))
    ).toBeNull();
  });

  it("malformed kitRef invalidates the template (never silently select a wrong kit)", () => {
    expect(
      decodeTemplateParam(b64url(JSON.stringify({ ...VALID, kitRef: { source: "local" } }))) // missing localKitId
    ).toBeNull();
    expect(decodeTemplateParam(b64url(JSON.stringify({ ...VALID, kitRef: "kit-1" })))).toBeNull();
  });

  it("an invalid per-type config is DROPPED while the template survives", () => {
    const withBadConfig = { ...VALID, trigger: { type: "schedule", config: { cron: 42 } } };
    const decoded = decodeTemplateParam(b64url(JSON.stringify(withBadConfig)));
    expect(decoded).not.toBeNull();
    expect(decoded?.trigger.type).toBe("schedule");
    expect(decoded?.trigger.config).toBeUndefined();
  });

  it("name is trimmed", () => {
    const decoded = decodeTemplateParam(b64url(JSON.stringify({ ...VALID, name: "  Daily digest  " })));
    expect(decoded?.name).toBe("Daily digest");
  });
});
