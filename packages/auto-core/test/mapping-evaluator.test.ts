/**
 * Mapping-evaluator tests — S1 enforcement: safe path walking (no proto-chain
 * access), every filter op, regex safety gate, interpolation caps, single-pass
 * (no re-expansion) rendering, and payload-attach caps.
 */

import { describe, expect, it } from "vitest";
import {
  buildRunInput,
  evaluateFilters,
  isSafeMatchPattern,
  renderPrompt,
  resolvePath,
} from "../src/core/mapping-evaluator.js";
import {
  EVENT_PAYLOAD_MAX_BYTES,
  MAPPING_FIELD_INTERPOLATION_MAX_CHARS,
  MAPPING_TOTAL_PROMPT_MAX_CHARS,
} from "../src/core/types.js";
import type { TriggerFilter, TriggerMapping } from "../src/core/types.js";

function mapping(over: Partial<TriggerMapping> = {}): TriggerMapping {
  return {
    promptTemplate: "Do the thing.",
    attachPayloadAs: "event.json",
    fileHandling: "attach",
    ...over,
  };
}

describe("resolvePath (safe walker)", () => {
  const payload = {
    action: "opened",
    issue: { labels: ["bug", "p1"], number: 42, "content-type": "json" },
    empty: null,
  };

  it("resolves dot paths, bracket indexes, and quoted bracket keys", () => {
    expect(resolvePath(payload, "action")).toEqual({ found: true, value: "opened" });
    expect(resolvePath(payload, "issue.labels[0]")).toEqual({ found: true, value: "bug" });
    expect(resolvePath(payload, "issue.number")).toEqual({ found: true, value: 42 });
    expect(resolvePath(payload, 'issue["content-type"]')).toEqual({ found: true, value: "json" });
    expect(resolvePath(payload, "issue['content-type']")).toEqual({ found: true, value: "json" });
  });

  it("reports missing paths as not found", () => {
    expect(resolvePath(payload, "nope").found).toBe(false);
    expect(resolvePath(payload, "issue.labels[9]").found).toBe(false);
    expect(resolvePath(payload, "empty.deeper").found).toBe(false);
    expect(resolvePath(undefined, "anything").found).toBe(false);
  });

  it("rejects __proto__/constructor/prototype segments outright", () => {
    expect(resolvePath(payload, "__proto__").found).toBe(false);
    expect(resolvePath(payload, "issue.__proto__.polluted").found).toBe(false);
    expect(resolvePath(payload, "constructor").found).toBe(false);
    expect(resolvePath(payload, "constructor.prototype").found).toBe(false);
    expect(resolvePath(payload, 'issue["__proto__"]').found).toBe(false);
    expect(resolvePath(payload, "issue['prototype']").found).toBe(false);
  });

  it("never walks the prototype chain (inherited props are not found)", () => {
    expect(resolvePath(payload, "toString").found).toBe(false);
    expect(resolvePath(payload, "hasOwnProperty").found).toBe(false);
    // Arrays: no non-index property access.
    expect(resolvePath(payload, "issue.labels.length").found).toBe(false);
    // Primitives expose no properties.
    expect(resolvePath(payload, "action.length").found).toBe(false);
  });

  it("rejects malformed paths", () => {
    expect(resolvePath(payload, "").found).toBe(false);
    expect(resolvePath(payload, "a..b").found).toBe(false);
    expect(resolvePath(payload, ".leading").found).toBe(false);
    expect(resolvePath(payload, "a[unquoted]").found).toBe(false);
    expect(resolvePath(payload, "a[1").found).toBe(false);
    expect(resolvePath(payload, "a".repeat(201)).found).toBe(false);
  });
});

describe("evaluateFilters — ops", () => {
  const payload = {
    action: "opened",
    count: 5,
    countStr: "12",
    flag: true,
    nul: null,
    labels: ["bug", "p1"],
    title: "Fix the parser crash",
  };

  const f = (path: string, op: TriggerFilter["op"], value?: TriggerFilter["value"]): TriggerFilter =>
    ({ path, op, ...(value !== undefined ? { value } : {}) }) as TriggerFilter;

  it("eq is strict (no cross-type coercion)", () => {
    expect(evaluateFilters([f("action", "eq", "opened")], payload).pass).toBe(true);
    expect(evaluateFilters([f("count", "eq", 5)], payload).pass).toBe(true);
    expect(evaluateFilters([f("count", "eq", "5")], payload).pass).toBe(false);
    expect(evaluateFilters([f("nul", "eq", null)], payload).pass).toBe(true);
    expect(evaluateFilters([f("missing", "eq", "x")], payload).pass).toBe(false);
  });

  it("ne passes on mismatch and on missing fields", () => {
    expect(evaluateFilters([f("action", "ne", "closed")], payload).pass).toBe(true);
    expect(evaluateFilters([f("action", "ne", "opened")], payload).pass).toBe(false);
    expect(evaluateFilters([f("missing", "ne", "anything")], payload).pass).toBe(true);
  });

  it("gt/lt/gte/lte coerce numbers safely (numeric strings ok, junk fails)", () => {
    expect(evaluateFilters([f("count", "gt", 4)], payload).pass).toBe(true);
    expect(evaluateFilters([f("count", "gt", 5)], payload).pass).toBe(false);
    expect(evaluateFilters([f("count", "gte", 5)], payload).pass).toBe(true);
    expect(evaluateFilters([f("count", "lt", 6)], payload).pass).toBe(true);
    expect(evaluateFilters([f("count", "lte", 4)], payload).pass).toBe(false);
    expect(evaluateFilters([f("countStr", "gt", 10)], payload).pass).toBe(true);
    expect(evaluateFilters([f("count", "gt", "4")], payload).pass).toBe(true);
    // Non-numeric values never compare true.
    expect(evaluateFilters([f("action", "gt", 1)], payload).pass).toBe(false);
    expect(evaluateFilters([f("flag", "gt", 0)], payload).pass).toBe(false);
    expect(evaluateFilters([f("missing", "gt", 0)], payload).pass).toBe(false);
  });

  it("contains handles strings and arrays", () => {
    expect(evaluateFilters([f("title", "contains", "parser")], payload).pass).toBe(true);
    expect(evaluateFilters([f("title", "contains", "zebra")], payload).pass).toBe(false);
    expect(evaluateFilters([f("labels", "contains", "bug")], payload).pass).toBe(true);
    expect(evaluateFilters([f("labels", "contains", "feature")], payload).pass).toBe(false);
    expect(evaluateFilters([f("count", "contains", 5)], payload).pass).toBe(false);
  });

  it("exists checks own-property presence", () => {
    expect(evaluateFilters([f("action", "exists")], payload).pass).toBe(true);
    expect(evaluateFilters([f("nul", "exists")], payload).pass).toBe(true);
    expect(evaluateFilters([f("missing", "exists")], payload).pass).toBe(false);
    expect(evaluateFilters([f("toString", "exists")], payload).pass).toBe(false);
  });

  it("matches applies safe patterns to strings (and stringified primitives)", () => {
    expect(evaluateFilters([f("title", "matches", "^Fix .*crash$")], payload).pass).toBe(true);
    expect(evaluateFilters([f("title", "matches", "^Bug")], payload).pass).toBe(false);
    expect(evaluateFilters([f("count", "matches", "^5$")], payload).pass).toBe(true);
    expect(evaluateFilters([f("labels", "matches", "bug")], payload).pass).toBe(false);
    expect(evaluateFilters([f("missing", "matches", "x")], payload).pass).toBe(false);
  });

  it("matches rejects unsafe patterns (fails the filter)", () => {
    expect(evaluateFilters([f("title", "matches", "(a+)+$")], payload).pass).toBe(false);
    expect(evaluateFilters([f("title", "matches", "(a)\\1")], payload).pass).toBe(false);
    expect(evaluateFilters([f("title", "matches", "x".repeat(201))], payload).pass).toBe(false);
    // Invalid regex also just fails.
    expect(evaluateFilters([f("title", "matches", "[unclosed")], payload).pass).toBe(false);
  });

  it("matches hard-caps the evaluated input", () => {
    const big = { text: "a".repeat(MAPPING_FIELD_INTERPOLATION_MAX_CHARS + 500) + "Z" };
    // "Z" sits beyond the cap — the capped subject cannot match it.
    expect(evaluateFilters([f("text", "matches", "Z$")], big).pass).toBe(false);
    expect(evaluateFilters([f("text", "matches", "^a")], big).pass).toBe(true);
  });

  it("reports the index of the first failing filter", () => {
    const verdict = evaluateFilters(
      [f("action", "eq", "opened"), f("count", "gt", 100), f("flag", "exists")],
      payload,
    );
    expect(verdict).toEqual({ pass: false, failedAt: 1 });
    expect(
      evaluateFilters([f("action", "eq", "opened"), f("flag", "exists")], payload),
    ).toEqual({ pass: true });
  });
});

describe("isSafeMatchPattern (linear-time heuristic)", () => {
  it("accepts plain literal-ish patterns", () => {
    expect(isSafeMatchPattern("^deploy-[a-z0-9]+$")).toBe(true);
    expect(isSafeMatchPattern("error|warning")).toBe(true);
    expect(isSafeMatchPattern("a+b*c{1,3}")).toBe(true);
    expect(isSafeMatchPattern("\\(literal\\)+")).toBe(true); // escaped paren, no group
    expect(isSafeMatchPattern("[)+]*")).toBe(true); // class members, no group
  });

  it("rejects backreferences", () => {
    expect(isSafeMatchPattern("(a)\\1")).toBe(false);
    expect(isSafeMatchPattern("(?<x>a)\\k<x>")).toBe(false);
  });

  it("rejects quantified groups (nested-quantifier shapes)", () => {
    expect(isSafeMatchPattern("(a+)+")).toBe(false);
    expect(isSafeMatchPattern("(a|b)*")).toBe(false);
    expect(isSafeMatchPattern("(ab){2,}")).toBe(false);
  });

  it("rejects empty and over-long patterns", () => {
    expect(isSafeMatchPattern("")).toBe(false);
    expect(isSafeMatchPattern("a".repeat(200))).toBe(true);
    expect(isSafeMatchPattern("a".repeat(201))).toBe(false);
  });
});

describe("renderPrompt (S1: single-pass, capped)", () => {
  it("interpolates values by path; missing paths render empty", () => {
    const m = mapping({ promptTemplate: "Triage {{issue.title}} by {{user.login}}{{nope}}." });
    const out = renderPrompt(m, { issue: { title: "Crash" }, user: { login: "octo" } });
    expect(out).toBe("Triage Crash by octo.");
  });

  it("JSON-stringifies non-string values", () => {
    const m = mapping({ promptTemplate: "n={{n}} obj={{o}} arr={{a}} b={{b}}" });
    const out = renderPrompt(m, { n: 7, o: { k: 1 }, a: [1, 2], b: false });
    expect(out).toBe('n=7 obj={"k":1} arr=[1,2] b=false');
  });

  it("NEVER re-expands payload content (single-pass; payload is data)", () => {
    const m = mapping({ promptTemplate: "Say: {{msg}}" });
    const out = renderPrompt(m, { msg: "{{secret}}", secret: "LEAK" });
    expect(out).toBe("Say: {{secret}}");
    expect(out).not.toContain("LEAK");
  });

  it("rejects proto-chain interpolation paths (renders empty)", () => {
    const m = mapping({ promptTemplate: "x={{__proto__}} y={{constructor.name}}" });
    expect(renderPrompt(m, { a: 1 })).toBe("x= y=");
  });

  it("caps each interpolated field at MAPPING_FIELD_INTERPOLATION_MAX_CHARS", () => {
    const m = mapping({ promptTemplate: "{{big}}" });
    const out = renderPrompt(m, { big: "x".repeat(MAPPING_FIELD_INTERPOLATION_MAX_CHARS + 999) });
    expect(out).toHaveLength(MAPPING_FIELD_INTERPOLATION_MAX_CHARS);
  });

  it("caps the final prompt at MAPPING_TOTAL_PROMPT_MAX_CHARS", () => {
    const m = mapping({ promptTemplate: "{{a}}{{b}}{{c}}{{d}}{{e}}" });
    const big = "y".repeat(MAPPING_FIELD_INTERPOLATION_MAX_CHARS);
    const out = renderPrompt(m, { a: big, b: big, c: big, d: big, e: big });
    expect(out).toHaveLength(MAPPING_TOTAL_PROMPT_MAX_CHARS);
  });
});

describe("buildRunInput", () => {
  it("builds prompt + event metadata + attached payload file", () => {
    const m = mapping({ promptTemplate: "Handle {{action}}." });
    const payload = { action: "push", ref: "main" };
    const input = buildRunInput(m, payload, "repo.push");
    expect(input.prompt).toBe("Handle push.");
    expect(input.event).toEqual({ name: "repo.push" });
    expect(input.files).toEqual([{ path: "event.json", content: JSON.stringify(payload) }]);
  });

  it("skips the attachment when attachPayloadAs is null or payload absent", () => {
    const m1 = mapping({ attachPayloadAs: null });
    expect(buildRunInput(m1, { a: 1 }, "e").files).toBeUndefined();
    const m2 = mapping();
    expect(buildRunInput(m2, undefined, "schedule").files).toBeUndefined();
  });

  it("caps the attached payload at EVENT_PAYLOAD_MAX_BYTES", () => {
    const m = mapping();
    const payload = { blob: "z".repeat(EVENT_PAYLOAD_MAX_BYTES + 5000) };
    const input = buildRunInput(m, payload, "big");
    const file = input.files?.[0];
    expect(file).toBeDefined();
    expect(Buffer.byteLength(file!.content, "utf8")).toBeLessThanOrEqual(EVENT_PAYLOAD_MAX_BYTES);
  });

  it("caps multi-byte payloads without splitting a code point", () => {
    const m = mapping();
    const payload = { blob: "é".repeat(EVENT_PAYLOAD_MAX_BYTES) }; // 2 bytes each
    const input = buildRunInput(m, payload, "big");
    const content = input.files?.[0]?.content ?? "";
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(EVENT_PAYLOAD_MAX_BYTES);
    expect(content).not.toContain("�");
  });
});
