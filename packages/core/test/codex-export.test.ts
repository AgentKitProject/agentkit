import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { exportAgentKitToCodex } from "../src/adapters/codex.js";
import { createCliProgram } from "../src/cli/program.js";
import { createAgentKit } from "../src/init/create.js";

describe("Codex skills export", () => {
  test("exports a valid kit to a temp Codex skills dir", async () => {
    const kit = await createFinancialReviewKit();
    const dest = await tempDir("agentkitforge-codex-dest-");

    const result = await exportAgentKitToCodex(kit, dest);

    expect(result.destinationSkillsDir).toBe(path.resolve(dest));
    expect(result.exportedSkillFolders).toHaveLength(2);
    expect(result.generatedIndexFolder).toBe(path.join(dest, "financial-review-index"));
  });

  test("creates one namespaced folder per skill and an index skill", async () => {
    const kit = await createFinancialReviewKit();
    const dest = await tempDir("agentkitforge-codex-dest-");

    await exportAgentKitToCodex(kit, dest);

    await expect(readFile(path.join(dest, "financial-review-audit-formulas", "SKILL.md"), "utf8")).resolves.toContain("# Audit Formulas");
    await expect(readFile(path.join(dest, "financial-review-map-workbook-structure", "SKILL.md"), "utf8")).resolves.toContain("# Map Workbook Structure");
    await expect(readFile(path.join(dest, "financial-review-index", "SKILL.md"), "utf8")).resolves.toContain("Included skills:");
  });

  test("force=false refuses overwrite", async () => {
    const kit = await createFinancialReviewKit();
    const dest = await tempDir("agentkitforge-codex-dest-");
    await exportAgentKitToCodex(kit, dest);

    await expect(exportAgentKitToCodex(kit, dest)).rejects.toThrow(
      "Refusing to overwrite existing Codex skill export folders"
    );
  });

  test("force=true replaces only this kit's generated folders", async () => {
    const kit = await createFinancialReviewKit();
    const dest = await tempDir("agentkitforge-codex-dest-");
    await exportAgentKitToCodex(kit, dest);
    await writeFile(path.join(dest, "financial-review-audit-formulas", "stale.txt"), "stale\n", "utf8");
    await mkdir(path.join(dest, "unrelated-skill"));
    await writeFile(path.join(dest, "unrelated-skill", "SKILL.md"), "# Unrelated\n", "utf8");

    await exportAgentKitToCodex(kit, dest, { force: true });

    await expect(pathExists(path.join(dest, "financial-review-audit-formulas", "stale.txt"))).resolves.toBe(false);
    await expect(readFile(path.join(dest, "unrelated-skill", "SKILL.md"), "utf8")).resolves.toBe("# Unrelated\n");
    await expect(readFile(path.join(dest, "financial-review-audit-formulas", "SKILL.md"), "utf8")).resolves.toContain("# Audit Formulas");
  });

  test("force=true does not delete unrelated folder with colliding generated name", async () => {
    const kit = await createFinancialReviewKit();
    const dest = await tempDir("agentkitforge-codex-dest-");
    await mkdir(path.join(dest, "financial-review-audit-formulas"));
    await writeFile(
      path.join(dest, "financial-review-audit-formulas", "SKILL.md"),
      "# User Skill\n",
      "utf8"
    );

    await expect(exportAgentKitToCodex(kit, dest, { force: true })).rejects.toThrow(
      "Refusing to remove non-AgentKitForge folder"
    );
    await expect(readFile(path.join(dest, "financial-review-audit-formulas", "SKILL.md"), "utf8")).resolves.toBe("# User Skill\n");
  });

  test("exported files contain expected SKILL.md content and generated AGENTKIT.md", async () => {
    const kit = await createFinancialReviewKit();
    const dest = await tempDir("agentkitforge-codex-dest-");

    await exportAgentKitToCodex(kit, dest);

    await expect(readFile(path.join(dest, "financial-review-audit-formulas", "SKILL.md"), "utf8")).resolves.toContain("## Procedure");
    await expect(readFile(path.join(dest, "financial-review-audit-formulas", "AGENTKIT.md"), "utf8")).resolves.toContain("exported from Agent Kit `financial-review`");
  });

  test("CLI exports Codex skills JSON result", async () => {
    const kit = await createFinancialReviewKit();
    const dest = await tempDir("agentkitforge-codex-dest-");

    const output = await runExportCodexCommand([kit, "--dest", dest]);
    const result = JSON.parse(output) as { exportedSkillFolders: string[]; generatedIndexFolder?: string };

    expect(result.exportedSkillFolders).toHaveLength(2);
    expect(result.generatedIndexFolder).toBe(path.join(dest, "financial-review-index"));
  });
});

async function createFinancialReviewKit(): Promise<string> {
  const kit = await tempDir("agentkitforge-codex-kit-");
  await createAgentKit(kit, {
    template: "financial-review",
    id: "financial-review",
    name: "Financial Review",
    description: "Review financial workbooks."
  });
  return kit;
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runExportCodexCommand(args: string[]): Promise<string> {
  let output = "";
  const originalLog = console.log;
  const program = createCliProgram();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined
  });
  console.log = (value?: unknown) => {
    output += String(value);
  };

  try {
    await program.parseAsync(["export-codex", ...args], { from: "user" });
    return output;
  } finally {
    console.log = originalLog;
  }
}
