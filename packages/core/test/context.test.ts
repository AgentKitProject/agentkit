import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createCliProgram } from "../src/cli/program.js";
import { buildAgentKitContext } from "../src/context/builder.js";
import { createAgentKit } from "../src/init/create.js";

describe("Agent Kit context builder", () => {
  test("all mode includes AGENTKIT.md and all skills", async () => {
    const kit = await createFinancialReviewKit();

    const context = await buildAgentKitContext({
      kitPath: kit,
      mode: "all",
      target: "generic"
    });

    expect(context.includedFiles).toEqual(
      expect.arrayContaining([
        "AGENTKIT.md",
        "skills/audit-formulas/SKILL.md",
        "skills/map-workbook-structure/SKILL.md"
      ])
    );
    expect(context.includedSkills).toEqual(["audit-formulas", "map-workbook-structure"]);
    expect(context.systemContext).toContain("--- FILE: AGENTKIT.md ---");
  });

  test("triggered mode includes matching skill by trigger", async () => {
    const kit = await createFinancialReviewKit();

    const context = await buildAgentKitContext({
      kitPath: kit,
      userTask: "Please audit formulas in this workbook.",
      mode: "triggered",
      target: "generic"
    });

    expect(context.includedSkills).toEqual(["audit-formulas"]);
    expect(context.includedFiles).toEqual(
      expect.arrayContaining(["AGENTKIT.md", "skills/audit-formulas/SKILL.md"])
    );
    expect(context.includedFiles).not.toContain("skills/map-workbook-structure/SKILL.md");
  });

  test("triggered mode falls back to all skills if no match", async () => {
    const kit = await createFinancialReviewKit();

    const context = await buildAgentKitContext({
      kitPath: kit,
      userTask: "Write a poem about deployment.",
      mode: "triggered",
      target: "generic"
    });

    expect(context.includedSkills).toEqual(["audit-formulas", "map-workbook-structure"]);
    expect(context.warnings).toContain("No specific skill matched the task; included all skills.");
  });

  test("policies, templates, and workflows are included when requested", async () => {
    const kit = await createFinancialReviewKit();
    await addOptionalContextFiles(kit);

    const context = await buildAgentKitContext({
      kitPath: kit,
      userTask: "Please audit formulas in this workbook.",
      mode: "triggered",
      target: "generic",
      includePolicies: true,
      includeTemplates: true,
      includeWorkflows: true
    });

    expect(context.includedFiles).toEqual(
      expect.arrayContaining([
        "policies/financial-review-guardrails.yaml",
        "templates/review-note.md",
        "workflows/monthly-review.md"
      ])
    );
    expect(context.systemContext).toContain("--- FILE: templates/review-note.md ---");
  });

  test("includedFiles are accurate", async () => {
    const kit = await createFinancialReviewKit();

    const context = await buildAgentKitContext({
      kitPath: kit,
      userTask: "Please map workbook structure.",
      mode: "triggered",
      target: "generic",
      includePolicies: true
    });

    expect(context.includedFiles).toEqual([
      "AGENTKIT.md",
      "skills/map-workbook-structure/SKILL.md",
      "policies/financial-review-guardrails.yaml"
    ]);
  });

  test("CLI writes context JSON", async () => {
    const kit = await createFinancialReviewKit();
    const tmp = await mkdtemp(path.join(os.tmpdir(), "agentkitforge-context-out-"));
    const out = path.join(tmp, "context.json");

    await runBuildContextCommand([
      kit,
      "--task",
      "Please audit formulas in this workbook.",
      "--mode",
      "triggered",
      "--target",
      "generic",
      "--out",
      out
    ]);

    const context = JSON.parse(await readFile(out, "utf8")) as {
      includedFiles: string[];
      includedSkills: string[];
      systemContext: string;
      userContext: string;
    };

    expect(context.includedSkills).toEqual(["audit-formulas"]);
    expect(context.includedFiles).toContain("AGENTKIT.md");
    expect(context.systemContext).toContain("Target: generic");
    expect(context.userContext).toContain("Please audit formulas");
  });
});

async function createFinancialReviewKit(): Promise<string> {
  const kit = await mkdtemp(path.join(os.tmpdir(), "agentkitforge-context-"));
  await createAgentKit(kit, {
    template: "financial-review",
    id: "financial-review",
    name: "Financial Review",
    description: "Review financial workbooks."
  });
  return kit;
}

async function addOptionalContextFiles(kit: string): Promise<void> {
  await mkdir(path.join(kit, "templates"), { recursive: true });
  await writeFile(path.join(kit, "templates", "review-note.md"), "# Review Note\n", "utf8");
  await mkdir(path.join(kit, "workflows"), { recursive: true });
  await writeFile(path.join(kit, "workflows", "monthly-review.md"), "# Monthly Review\n", "utf8");
}

async function runBuildContextCommand(args: string[]): Promise<void> {
  const program = createCliProgram();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined
  });
  await program.parseAsync(["build-context", ...args], { from: "user" });
}
