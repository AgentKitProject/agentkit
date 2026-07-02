/**
 * The clickable field tree's pure layer (lib/automations/field-tree.ts):
 * payload flattening into dot/bracket paths (the same addressing
 * triggerFilterSchema documents) and cursor insertion of {{path}} tokens.
 */
import { describe, expect, it } from "vitest";
import { flattenPayloadFields, insertPlaceholderAt } from "@/lib/automations/field-tree";

describe("flattenPayloadFields", () => {
  it("flattens nested objects and arrays into dot/bracket paths", () => {
    const fields = flattenPayloadFields({
      action: "opened",
      issue: { title: "Bug!", labels: ["p1", "ui"] }
    });
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
    expect(byPath["action"].isLeaf).toBe(true);
    expect(byPath["action"].preview).toBe('"opened"');
    expect(byPath["issue"].isLeaf).toBe(false);
    expect(byPath["issue.title"].isLeaf).toBe(true);
    expect(byPath["issue.labels"].isLeaf).toBe(false);
    expect(byPath["issue.labels[0]"].preview).toBe('"p1"');
    expect(byPath["issue.labels[1]"].preview).toBe('"ui"');
  });

  it("bracket-quotes non-identifier keys", () => {
    const fields = flattenPayloadFields({ "content-type": "json", ok: true });
    expect(fields.map((f) => f.path)).toContain('["content-type"]');
  });

  it("tracks depth for indentation", () => {
    const fields = flattenPayloadFields({ a: { b: { c: 1 } } });
    const depths = Object.fromEntries(fields.map((f) => [f.path, f.depth]));
    expect(depths).toEqual({ a: 0, "a.b": 1, "a.b.c": 2 });
  });

  it("caps array items and total node count", () => {
    const big = { arr: Array.from({ length: 50 }, (_, i) => i) };
    const fields = flattenPayloadFields(big);
    expect(fields.filter((f) => f.path.startsWith("arr[")).length).toBe(5); // maxArrayItems

    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    expect(flattenPayloadFields(wide).length).toBeLessThanOrEqual(200); // maxNodes
  });

  it("truncates long previews", () => {
    const fields = flattenPayloadFields({ text: "x".repeat(500) });
    expect(fields[0].preview!.length).toBeLessThanOrEqual(40);
    expect(fields[0].preview!.endsWith("…")).toBe(true);
  });

  it("handles non-object payloads with a single root row", () => {
    const fields = flattenPayloadFields("just a string");
    expect(fields).toHaveLength(1);
    expect(fields[0].isLeaf).toBe(true);
  });

  it("null and primitive leaves keep previews", () => {
    const fields = flattenPayloadFields({ n: null, b: false, x: 0 });
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f.preview]));
    expect(byPath["n"]).toBe("null");
    expect(byPath["b"]).toBe("false");
    expect(byPath["x"]).toBe("0");
  });
});

describe("insertPlaceholderAt", () => {
  it("inserts {{path}} at the cursor and returns the new caret", () => {
    const r = insertPlaceholderAt("Summarize  please", 10, "issue.title");
    expect(r.text).toBe("Summarize {{issue.title}} please");
    expect(r.cursor).toBe(10 + "{{issue.title}}".length);
  });

  it("clamps out-of-range cursors to the text bounds", () => {
    expect(insertPlaceholderAt("abc", 999, "x").text).toBe("abc{{x}}");
    expect(insertPlaceholderAt("abc", -5, "x").text).toBe("{{x}}abc");
  });
});
