import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import YAML from "yaml";
import { afterEach, describe, expect, test } from "vitest";
import { getKitAutomations, getKitAutomationsFromZip } from "../src/app/automations.js";
import { inspectAgentKitCandidate } from "../src/app/inspect.js";
import { getAgentKitSummary } from "../src/app/summary.js";
import {
  agentKitAutomationSchema,
  agentKitAutomationsSchema,
  agentKitManifestSchema
} from "../src/schema/agentkit.js";
import { validateAgentKit } from "../src/validation/validator.js";
import type { AgentKitAutomation } from "../src/types.js";

const fixturesRoot = path.join(process.cwd(), "test", "fixtures");

const scheduleAutomation = {
  name: "Daily financial summary",
  description: "Summarize yesterday's transactions every morning.",
  trigger: {
    type: "schedule",
    config: { cron: "0 9 * * *", timezone: "America/New_York" }
  },
  promptTemplate: "Summarize the last 24 hours of transactions."
};

const eventAutomation = {
  name: "New invoice triage",
  trigger: {
    type: "event",
    config: { eventName: "invoice.received" }
  },
  promptTemplate: "Triage the incoming invoice and draft a review note."
};

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("automation schema", () => {
  test("accepts a schedule automation with suggested cron and timezone", () => {
    expect(agentKitAutomationSchema.safeParse(scheduleAutomation).success).toBe(true);
  });

  test("accepts an event automation with a suggested event name", () => {
    expect(agentKitAutomationSchema.safeParse(eventAutomation).success).toBe(true);
  });

  test("accepts a minimal automation without description or trigger config", () => {
    const result = agentKitAutomationSchema.safeParse({
      name: "Weekly digest",
      trigger: { type: "schedule" },
      promptTemplate: "Produce the weekly digest."
    });

    expect(result.success).toBe(true);
  });

  test("rejects unknown keys in an entry (no smuggled approvals)", () => {
    const result = agentKitAutomationSchema.safeParse({
      ...scheduleAutomation,
      approvalId: "auto-approve-me"
    });

    expect(result.success).toBe(false);
  });

  test("rejects unknown keys in an entry (no smuggled destinations)", () => {
    const result = agentKitAutomationSchema.safeParse({
      ...eventAutomation,
      destinations: ["slack://finance"]
    });

    expect(result.success).toBe(false);
  });

  test("rejects unknown keys in the trigger (no smuggled budgets or connections)", () => {
    expect(
      agentKitAutomationSchema.safeParse({
        ...scheduleAutomation,
        trigger: { type: "schedule", budgetUsd: 100 }
      }).success
    ).toBe(false);

    expect(
      agentKitAutomationSchema.safeParse({
        ...eventAutomation,
        trigger: { type: "event", config: { eventName: "x", connectionId: "conn_1" } }
      }).success
    ).toBe(false);
  });

  test("rejects schedule-only config keys on event triggers and vice versa", () => {
    expect(
      agentKitAutomationSchema.safeParse({
        ...eventAutomation,
        trigger: { type: "event", config: { cron: "0 9 * * *" } }
      }).success
    ).toBe(false);

    expect(
      agentKitAutomationSchema.safeParse({
        ...scheduleAutomation,
        trigger: { type: "schedule", config: { eventName: "invoice.received" } }
      }).success
    ).toBe(false);
  });

  test("requires promptTemplate", () => {
    const { promptTemplate: _omitted, ...withoutPrompt } = scheduleAutomation;
    expect(agentKitAutomationSchema.safeParse(withoutPrompt).success).toBe(false);
    expect(
      agentKitAutomationSchema.safeParse({ ...scheduleAutomation, promptTemplate: "" }).success
    ).toBe(false);
  });

  test("enforces field length limits", () => {
    expect(
      agentKitAutomationSchema.safeParse({ ...scheduleAutomation, name: "a".repeat(81) }).success
    ).toBe(false);
    expect(
      agentKitAutomationSchema.safeParse({ ...scheduleAutomation, description: "a".repeat(301) })
        .success
    ).toBe(false);
    expect(
      agentKitAutomationSchema.safeParse({
        ...scheduleAutomation,
        promptTemplate: "a".repeat(4001)
      }).success
    ).toBe(false);
    expect(
      agentKitAutomationSchema.safeParse({
        ...scheduleAutomation,
        promptTemplate: "a".repeat(4000)
      }).success
    ).toBe(true);
  });

  test("rejects unknown trigger types", () => {
    expect(
      agentKitAutomationSchema.safeParse({
        ...scheduleAutomation,
        trigger: { type: "webhook" }
      }).success
    ).toBe(false);
  });

  test("caps the automations list at 10 entries", () => {
    const ten = Array.from({ length: 10 }, (_, index) => ({
      ...scheduleAutomation,
      name: `Automation ${index + 1}`
    }));

    expect(agentKitAutomationsSchema.safeParse(ten).success).toBe(true);
    expect(
      agentKitAutomationsSchema.safeParse([...ten, { ...scheduleAutomation, name: "Automation 11" }])
        .success
    ).toBe(false);
  });

  test("manifest schema accepts a kit without automations (additive optional field)", async () => {
    const manifestRaw = YAML.parse(
      await readFile(path.join(fixturesRoot, "valid-local", "agentkit.yaml"), "utf8")
    ) as Record<string, unknown>;

    expect(agentKitManifestSchema.safeParse(manifestRaw).success).toBe(true);

    manifestRaw.automations = [scheduleAutomation, eventAutomation];
    const withAutomations = agentKitManifestSchema.safeParse(manifestRaw);
    expect(withAutomations.success).toBe(true);
    // Additive optional field: schemaVersion stays "0.1".
    expect((withAutomations.data as { schemaVersion: string }).schemaVersion).toBe("0.1");
  });

  test("the SPEC.md automations example validates", async () => {
    const spec = await readFile(path.join(process.cwd(), "SPEC.md"), "utf8");
    const match = spec.match(/```yaml\n(automations:[\s\S]*?)```/);
    expect(match).not.toBeNull();

    const parsed = YAML.parse(match![1]) as { automations: unknown };
    expect(agentKitAutomationsSchema.safeParse(parsed.automations).success).toBe(true);
  });
});

describe("automation validation profiles", () => {
  test("publishable kit with valid automations passes", async () => {
    const kit = await copyFixture("valid-publishable");
    await appendAutomations(kit, [scheduleAutomation, eventAutomation]);

    const report = await validateAgentKit(kit, "publishable");

    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
  });

  test("malformed automations block fails publishable", async () => {
    const kit = await copyFixture("valid-publishable");
    await appendAutomations(kit, [{ ...scheduleAutomation, approvalId: "smuggled" }]);

    const report = await validateAgentKit(kit, "publishable");

    expect(report.valid).toBe(false);
    expect(
      report.issues.some(
        (issue) => issue.code === "manifest.field.invalid" && issue.message.includes("automations")
      )
    ).toBe(true);
  });

  test("local-valid tolerates absence but validates shape when present", async () => {
    const withoutBlock = await validateAgentKit(path.join(fixturesRoot, "valid-local"), "local-valid");
    expect(withoutBlock.valid).toBe(true);

    const kit = await copyFixture("valid-local");
    await appendAutomations(kit, [{ name: "Broken", trigger: { type: "schedule" } }]);

    const report = await validateAgentKit(kit, "local-valid");
    expect(report.valid).toBe(false);
  });
});

describe("getKitAutomations accessor", () => {
  test("returns an empty array when the block is absent", () => {
    expect(getKitAutomations({})).toEqual([]);
  });

  test("returns typed entries when the block is valid", () => {
    const automations = getKitAutomations({ automations: [scheduleAutomation, eventAutomation] });

    expect(automations).toHaveLength(2);
    expect(automations[0].trigger.type).toBe("schedule");
    expect(automations[1].trigger.type).toBe("event");
    expect(automations[0].promptTemplate).toContain("transactions");
  });

  test("returns an empty array for malformed blocks instead of leaking unknown keys", () => {
    expect(
      getKitAutomations({ automations: [{ ...scheduleAutomation, destinations: ["x"] }] })
    ).toEqual([]);
    expect(getKitAutomations({ automations: "not-a-list" })).toEqual([]);
  });
});

describe("automations in summary and inspect outputs", () => {
  test("getAgentKitSummary surfaces automation counts and entries", async () => {
    const kit = await copyFixture("valid-local");
    await appendAutomations(kit, [scheduleAutomation, eventAutomation]);

    const summary = await getAgentKitSummary(kit);

    expect(summary.counts.automations).toBe(2);
    expect(summary.lists.automations).toEqual([
      {
        name: scheduleAutomation.name,
        description: scheduleAutomation.description,
        trigger: scheduleAutomation.trigger,
        promptTemplate: scheduleAutomation.promptTemplate
      },
      {
        name: eventAutomation.name,
        description: undefined,
        trigger: eventAutomation.trigger,
        promptTemplate: eventAutomation.promptTemplate
      }
    ]);
  });

  test("getAgentKitSummary reports zero automations when the block is absent", async () => {
    const summary = await getAgentKitSummary(path.join(fixturesRoot, "valid-local"));

    expect(summary.counts.automations).toBe(0);
    expect(summary.lists.automations).toEqual([]);
  });

  test("inspectAgentKitCandidate surfaces manifest automations", async () => {
    const kit = await copyFixture("valid-local");
    await appendAutomations(kit, [eventAutomation]);

    const inspection = await inspectAgentKitCandidate(kit);

    expect(inspection.looksLikeAgentKit).toBe(true);
    expect(inspection.automations).toHaveLength(1);
    expect(inspection.automations[0].name).toBe(eventAutomation.name);
  });

  test("inspectAgentKitCandidate returns empty automations for non-kits", async () => {
    const inspection = await inspectAgentKitCandidate(path.join(fixturesRoot, "does-not-exist"));

    expect(inspection.exists).toBe(false);
    expect(inspection.automations).toEqual([]);
  });
});

describe("getKitAutomationsFromZip", () => {
  async function zipWithManifest(manifest: unknown): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file("agentkit.yaml", YAML.stringify(manifest));
    zip.file("AGENTKIT.md", "# Agent Kit");
    return zip.generateAsync({ type: "uint8array" });
  }

  test("extracts well-formed automations from a packaged kit's agentkit.yaml", async () => {
    const bytes = await zipWithManifest({
      schemaVersion: "0.1",
      name: "Example",
      automations: [scheduleAutomation, eventAutomation]
    });

    const automations = await getKitAutomationsFromZip(bytes);

    expect(automations).toHaveLength(2);
    expect(automations[0].name).toBe(scheduleAutomation.name);
    expect(automations[1].trigger.type).toBe("event");
  });

  test("returns [] when the manifest has no automations block", async () => {
    const bytes = await zipWithManifest({ schemaVersion: "0.1", name: "Example" });
    expect(await getKitAutomationsFromZip(bytes)).toEqual([]);
  });

  test("returns [] for a zip without agentkit.yaml", async () => {
    const zip = new JSZip();
    zip.file("README.md", "not a kit");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    expect(await getKitAutomationsFromZip(bytes)).toEqual([]);
  });

  test("returns [] for non-zip bytes and for malformed automations", async () => {
    expect(await getKitAutomationsFromZip(new TextEncoder().encode("not a zip"))).toEqual([]);

    const malformed = await zipWithManifest({
      schemaVersion: "0.1",
      name: "Example",
      automations: [{ ...scheduleAutomation, destinations: ["slack://finance"] }]
    });
    expect(await getKitAutomationsFromZip(malformed)).toEqual([]);
  });
});

async function copyFixture(fixture: string): Promise<string> {
  const target = await mkdtemp(path.join(os.tmpdir(), "agentkit-automations-"));
  tempRoots.push(target);
  await cp(path.join(fixturesRoot, fixture), target, { recursive: true });
  return target;
}

async function appendAutomations(kitRoot: string, automations: unknown[]): Promise<void> {
  const manifestPath = path.join(kitRoot, "agentkit.yaml");
  const manifest = YAML.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.automations = automations as AgentKitAutomation[];
  await writeFile(manifestPath, YAML.stringify(manifest), "utf8");
}
