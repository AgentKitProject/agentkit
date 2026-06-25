import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { exportAgentKitToClaudeCode } from "../src/adapters/claudeCode.js";
import { createCliProgram } from "../src/cli/program.js";
import { createAgentKit } from "../src/init/create.js";

describe("Claude Code plugin export", () => {
  test("exports a valid kit to a temp Claude Code plugins dir", async () => {
    const kit = await createFinancialReviewKit();
    const dest = await tempDir("agentkitforge-claude-dest-");

    const result = await exportAgentKitToClaudeCode(kit, dest);

    expect(result.destinationDir).toBe(path.resolve(dest));
    expect(result.pluginFolder).toBe(path.join(dest, "financial-review-claude-code-plugin"));
    expect(result.exportedSkillFolders).toHaveLength(2);
    expect(result.pluginManifestPath).toBe(
      path.join(dest, "financial-review-claude-code-plugin", ".claude-plugin", "plugin.json")
    );
  });

  test("creates plugin folder and .claude-plugin/plugin.json", async () => {
    const kit = await createFinancialReviewKit();
    const dest = await tempDir("agentkitforge-claude-dest-");

    await exportAgentKitToClaudeCode(kit, dest);
    const manifest = JSON.parse(
      await readFile(
        path.join(dest, "financial-review-claude-code-plugin", ".claude-plugin", "plugin.json"),
        "utf8"
      )
    ) as { generatedBy: string; target: string; skills: unknown[] };

    expect(manifest.generatedBy).toBe("agentkitforge");
    expect(manifest.target).toBe("claude-code");
    expect(manifest.skills).toHaveLength(2);
  });

  test("copies skills and includes AGENTKIT.md", async () => {
    const kit = await createFinancialReviewKit();
    const dest = await tempDir("agentkitforge-claude-dest-");

    await exportAgentKitToClaudeCode(kit, dest);

    await expect(
      readFile(
        path.join(dest, "financial-review-claude-code-plugin", "skills", "audit-formulas", "SKILL.md"),
        "utf8"
      )
    ).resolves.toContain("# Audit Formulas");
    await expect(
      readFile(
        path.join(dest, "financial-review-claude-code-plugin", "skills", "map-workbook-structure", "SKILL.md"),
        "utf8"
      )
    ).resolves.toContain("# Map Workbook Structure");
    await expect(
      readFile(path.join(dest, "financial-review-claude-code-plugin", "AGENTKIT.md"), "utf8")
    ).resolves.toContain("Use this Agent Kit");
  });

  test("force=false refuses overwrite", async () => {
    const kit = await createFinancialReviewKit();
    const dest = await tempDir("agentkitforge-claude-dest-");
    await exportAgentKitToClaudeCode(kit, dest);

    await expect(exportAgentKitToClaudeCode(kit, dest)).rejects.toThrow(
      "Refusing to overwrite existing Claude Code plugin folder"
    );
  });

  test("force=true replaces only this kit's plugin folder", async () => {
    const kit = await createFinancialReviewKit();
    const dest = await tempDir("agentkitforge-claude-dest-");
    await exportAgentKitToClaudeCode(kit, dest);
    await writeFile(
      path.join(dest, "financial-review-claude-code-plugin", "stale.txt"),
      "stale\n",
      "utf8"
    );
    await mkdir(path.join(dest, "unrelated-plugin"));
    await writeFile(path.join(dest, "unrelated-plugin", "README.md"), "# Unrelated\n", "utf8");

    await exportAgentKitToClaudeCode(kit, dest, { force: true });

    await expect(
      pathExists(path.join(dest, "financial-review-claude-code-plugin", "stale.txt"))
    ).resolves.toBe(false);
    await expect(readFile(path.join(dest, "unrelated-plugin", "README.md"), "utf8")).resolves.toBe(
      "# Unrelated\n"
    );
    await expect(
      readFile(
        path.join(dest, "financial-review-claude-code-plugin", "skills", "audit-formulas", "SKILL.md"),
        "utf8"
      )
    ).resolves.toContain("# Audit Formulas");
  });

  test("force=true does not delete unrelated folder with colliding plugin name", async () => {
    const kit = await createFinancialReviewKit();
    const dest = await tempDir("agentkitforge-claude-dest-");
    await mkdir(path.join(dest, "financial-review-claude-code-plugin"));
    await writeFile(
      path.join(dest, "financial-review-claude-code-plugin", "README.md"),
      "# User Plugin\n",
      "utf8"
    );

    await expect(exportAgentKitToClaudeCode(kit, dest, { force: true })).rejects.toThrow(
      "Refusing to remove non-AgentKitForge plugin folder"
    );
    await expect(
      readFile(path.join(dest, "financial-review-claude-code-plugin", "README.md"), "utf8")
    ).resolves.toBe("# User Plugin\n");
  });

  test("exported files contain expected content and supporting directories", async () => {
    const kit = await createFinancialReviewKit();
    const dest = await tempDir("agentkitforge-claude-dest-");

    await exportAgentKitToClaudeCode(kit, dest);

    await expect(
      readFile(
        path.join(dest, "financial-review-claude-code-plugin", "skills", "audit-formulas", "SKILL.md"),
        "utf8"
      )
    ).resolves.toContain("## Procedure");
    await expect(
      readFile(
        path.join(dest, "financial-review-claude-code-plugin", "policies", "financial-review-guardrails.yaml"),
        "utf8"
      )
    ).resolves.toContain("guardrails:");
    await expect(
      pathExists(path.join(dest, "financial-review-claude-code-plugin", "exports"))
    ).resolves.toBe(false);
  });

  test("CLI exports Claude Code plugin JSON result", async () => {
    const kit = await createFinancialReviewKit();
    const dest = await tempDir("agentkitforge-claude-dest-");

    const output = await runExportClaudeCodeCommand([kit, "--dest", dest]);
    const result = JSON.parse(output) as {
      pluginFolder: string;
      exportedSkillFolders: string[];
      pluginManifestPath: string;
    };

    expect(result.pluginFolder).toBe(path.join(dest, "financial-review-claude-code-plugin"));
    expect(result.exportedSkillFolders).toHaveLength(2);
    expect(result.pluginManifestPath).toBe(
      path.join(dest, "financial-review-claude-code-plugin", ".claude-plugin", "plugin.json")
    );
  });
});

async function createFinancialReviewKit(): Promise<string> {
  const kit = await tempDir("agentkitforge-claude-kit-");
  await createAgentKit(kit, {
    template: "financial-review",
    id: "financial-review",
    name: "Financial Review",
    description: "Review financial workbooks."
  });
  await mkdir(path.join(kit, "exports"));
  await writeFile(path.join(kit, "exports", "old.md"), "do not copy\n", "utf8");
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

async function runExportClaudeCodeCommand(args: string[]): Promise<string> {
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
    await program.parseAsync(["export-claude-code", ...args], { from: "user" });
    return output;
  } finally {
    console.log = originalLog;
  }
}
