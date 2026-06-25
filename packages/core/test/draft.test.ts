import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  AgentKitDraftValidationError,
  renderAgentKitDraft
} from "../src/draft/render.js";
import { validateAgentKit } from "../src/validation/validator.js";

const draftFixturesRoot = path.join(process.cwd(), "test", "fixtures", "drafts");

describe("AgentKit draft renderer", () => {
  test("minimal draft renders successfully", async () => {
    const draft = await readDraftFixture("minimal.json");
    const kit = await tempKitPath();

    const result = await renderAgentKitDraft(draft, kit);

    expect(result.files).toEqual(
      expect.arrayContaining([
        "agentkit.yaml",
        "AGENTKIT.md",
        "START_HERE.md",
        "README.md",
        "LICENSE",
        "CHANGELOG.md",
        "skills/summarize/SKILL.md"
      ])
    );
    await expect(readFile(path.join(kit, "skills", "summarize", "SKILL.md"), "utf8")).resolves.toContain(
      "# Summarize"
    );
  });

  test("minimal rendered kit validates as local-valid", async () => {
    const draft = await readDraftFixture("minimal.json");
    const kit = await tempKitPath();

    await renderAgentKitDraft(draft, kit);
    const report = await validateAgentKit(kit, "local-valid");

    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
  });

  test("financial draft renders successfully", async () => {
    const draft = await readDraftFixture("financial-review.json");
    const kit = await tempKitPath();

    const result = await renderAgentKitDraft(draft, kit);

    expect(result.files).toEqual(
      expect.arrayContaining([
        "skills/audit-formulas/SKILL.md",
        "skills/map-workbook-structure/SKILL.md",
        "policies/financial-review-guardrails.yaml",
        "examples/prompts/monthly-review.md",
        "examples/outputs/monthly-review.md"
      ])
    );
  });

  test("financial rendered kit validates as trusted", async () => {
    const draft = await readDraftFixture("financial-review.json");
    const kit = await tempKitPath();

    await renderAgentKitDraft(draft, kit);
    const report = await validateAgentKit(kit, "trusted");

    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
  });

  test("invalid draft fails with clear validation errors", async () => {
    const kit = await tempKitPath();

    await expect(
      renderAgentKitDraft(
        {
          id: "invalid draft",
          name: "",
          description: "Missing skills and invalid fields."
        },
        kit
      )
    ).rejects.toThrow(/Invalid Agent Kit draft:[\s\S]*id:[\s\S]*name:[\s\S]*skills/);

    try {
      await renderAgentKitDraft({ id: "invalid draft", name: "", description: "Bad." }, kit);
    } catch (error) {
      expect(error).toBeInstanceOf(AgentKitDraftValidationError);
      expect((error as AgentKitDraftValidationError).issues.join("\n")).toContain("skills");
    }
  });
});

async function readDraftFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(draftFixturesRoot, name), "utf8")) as unknown;
}

async function tempKitPath(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentkitforge-draft-"));
}
