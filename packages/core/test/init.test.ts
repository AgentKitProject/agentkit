import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createCliProgram } from "../src/cli/program.js";
import { createAgentKit } from "../src/init/create.js";
import { validateAgentKit } from "../src/validation/validator.js";

describe("AgentKit init", () => {
  test("creates a blank kit", async () => {
    const kit = await tempKitPath();

    const result = await createAgentKit(kit, {
      template: "blank",
      id: "starter-kit",
      name: "Starter Kit",
      description: "A starter Agent Kit."
    });

    expect(result.template).toBe("blank");
    expect(result.files).toEqual(
      expect.arrayContaining([
        "agentkit.yaml",
        "AGENTKIT.md",
        "START_HERE.md",
        "skills/first-skill/SKILL.md"
      ])
    );
    await expect(readFile(path.join(kit, "agentkit.yaml"), "utf8")).resolves.toContain(
      "id: \"starter-kit\""
    );
  });

  test("created blank kit validates as local-valid", async () => {
    const kit = await tempKitPath();
    await createAgentKit(kit, {
      template: "blank",
      id: "starter-kit",
      name: "Starter Kit",
      description: "A starter Agent Kit."
    });

    const report = await validateAgentKit(kit, "local-valid");

    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
  });

  test("creates a financial-review kit", async () => {
    const kit = await tempKitPath();

    const result = await createAgentKit(kit, {
      template: "financial-review",
      id: "financial-review",
      name: "Financial Review",
      description: "Review financial workbooks."
    });

    expect(result.template).toBe("financial-review");
    expect(result.files).toEqual(
      expect.arrayContaining([
        "agentkit.yaml",
        "AGENTKIT.md",
        "START_HERE.md",
        "README.md",
        "LICENSE",
        "CHANGELOG.md",
        "skills/map-workbook-structure/SKILL.md",
        "skills/audit-formulas/SKILL.md",
        "policies/financial-review-guardrails.yaml",
        "examples/prompts/monthly-review.md",
        "examples/outputs/monthly-review-summary.md"
      ])
    );
  });

  test("created financial-review kit validates as trusted", async () => {
    const kit = await tempKitPath();
    await createAgentKit(kit, {
      template: "financial-review",
      id: "financial-review",
      name: "Financial Review",
      description: "Review financial workbooks."
    });

    const report = await validateAgentKit(kit, "trusted");

    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
  });

  test("init command refuses to overwrite a non-empty directory unless --force is passed", async () => {
    const kit = await tempKitPath();
    await mkdir(kit, { recursive: true });
    await writeFile(path.join(kit, "existing.txt"), "keep\n", "utf8");

    await expect(
      runInitCommand([
        kit,
        "--template",
        "blank",
        "--id",
        "starter-kit",
        "--name",
        "Starter Kit",
        "--description",
        "A starter Agent Kit."
      ])
    ).rejects.toThrow("Refusing to initialize Agent Kit in non-empty directory");

    await expect(
      runInitCommand([
        kit,
        "--template",
        "blank",
        "--id",
        "starter-kit",
        "--name",
        "Starter Kit",
        "--description",
        "A starter Agent Kit.",
        "--force"
      ])
    ).resolves.toBeUndefined();

    await expect(pathExists(path.join(kit, "existing.txt"))).resolves.toBe(false);
    expect((await validateAgentKit(kit, "local-valid")).valid).toBe(true);
  });

  test("force cleans financial-review files before rendering blank", async () => {
    const kit = await tempKitPath();
    await createAgentKit(kit, {
      template: "financial-review",
      id: "financial-review",
      name: "Financial Review",
      description: "Review financial workbooks."
    });

    await createAgentKit(kit, {
      template: "blank",
      id: "blank-test-kit",
      name: "Blank Test Kit",
      description: "A blank test kit.",
      force: true
    });

    await expect(pathExists(path.join(kit, "skills", "audit-formulas", "SKILL.md"))).resolves.toBe(false);
    await expect(pathExists(path.join(kit, "skills", "map-workbook-structure", "SKILL.md"))).resolves.toBe(false);
    await expect(pathExists(path.join(kit, "policies", "financial-review-guardrails.yaml"))).resolves.toBe(false);
    await expect(pathExists(path.join(kit, "skills", "first-skill", "SKILL.md"))).resolves.toBe(true);
    expect((await validateAgentKit(kit, "local-valid")).valid).toBe(true);
  });

  test("force cleans blank files before rendering financial-review", async () => {
    const kit = await tempKitPath();
    await createAgentKit(kit, {
      template: "blank",
      id: "blank-test-kit",
      name: "Blank Test Kit",
      description: "A blank test kit."
    });

    await createAgentKit(kit, {
      template: "financial-review",
      id: "financial-review",
      name: "Financial Review",
      description: "Review financial workbooks.",
      force: true
    });

    await expect(pathExists(path.join(kit, "skills", "first-skill", "SKILL.md"))).resolves.toBe(false);
    await expect(pathExists(path.join(kit, "skills", "audit-formulas", "SKILL.md"))).resolves.toBe(true);
    await expect(pathExists(path.join(kit, "skills", "map-workbook-structure", "SKILL.md"))).resolves.toBe(true);
    await expect(pathExists(path.join(kit, "policies", "financial-review-guardrails.yaml"))).resolves.toBe(true);
    expect((await validateAgentKit(kit, "trusted")).valid).toBe(true);
  });
});

async function tempKitPath(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentkitforge-init-"));
}

async function runInitCommand(args: string[]): Promise<void> {
  const program = createCliProgram();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined
  });
  await program.parseAsync(["init", ...args], { from: "user" });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
