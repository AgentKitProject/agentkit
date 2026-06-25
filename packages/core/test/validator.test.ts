import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { exportOneFile } from "../src/export/onefile.js";
import { packageAgentKit } from "../src/package/packager.js";
import { validateAgentKit } from "../src/validation/validator.js";

const fixturesRoot = path.join(process.cwd(), "test", "fixtures");
const fixtureRoot = path.join(fixturesRoot, "valid-local");

describe("AgentKit validator", () => {
  test("accepts a valid local kit", async () => {
    const report = await validateAgentKit(fixtureRoot, "local-valid");

    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
  });

  test("accepts a valid publishable kit", async () => {
    const report = await validateAgentKit(
      path.join(fixturesRoot, "valid-publishable"),
      "publishable"
    );

    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
  });

  test("accepts a valid trusted kit", async () => {
    const report = await validateAgentKit(path.join(fixturesRoot, "valid-trusted"), "trusted");

    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
  });

  test("accepts a valid verified kit", async () => {
    const report = await validateAgentKit(path.join(fixturesRoot, "valid-verified"), "verified");

    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
  });

  test("reports missing required files", async () => {
    const kit = await copyFixture();
    await rm(path.join(kit, "START_HERE.md"));

    const report = await validateAgentKit(kit, "local-valid");

    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "package.required_path.missing",
        path: "START_HERE.md"
      })
    );
  });

  test("reports missing manifest fields", async () => {
    const kit = await copyFixture();
    await writeFile(
      path.join(kit, "agentkit.yaml"),
      [
        "schemaVersion: \"0.1\"",
        "kind: AgentKit",
        "id: invalid",
        "name: Invalid",
        "version: \"0.1.0\"",
        "description: Missing required fields"
      ].join("\n"),
      "utf8"
    );

    const report = await validateAgentKit(kit, "local-valid");

    expect(report.valid).toBe(false);
    expect(report.issues.some((issue) => issue.message.includes("author"))).toBe(true);
    expect(report.issues.some((issue) => issue.message.includes("skills"))).toBe(true);
  });

  test("reports missing skill frontmatter", async () => {
    const kit = await copyFixture();
    await writeFile(
      path.join(kit, "skills", "summarize", "SKILL.md"),
      [
        "---",
        "id: summarize",
        "name: Summarize",
        "description: Summarize provided text.",
        "riskLevel: low",
        "---",
        "",
        "# Summarize",
        "",
        "## Use when",
        "",
        "Use it.",
        "",
        "## Procedure",
        "",
        "Do it.",
        "",
        "## Output",
        "",
        "Return Markdown."
      ].join("\n"),
      "utf8"
    );

    const report = await validateAgentKit(kit, "local-valid");

    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "skill.frontmatter.missing",
        message: "Missing required SKILL.md frontmatter field: triggers"
      })
    );
  });

  test("reports missing skill sections", async () => {
    const kit = await copyFixture();
    const skillPath = path.join(kit, "skills", "summarize", "SKILL.md");
    const content = await readFile(skillPath, "utf8");
    await writeFile(skillPath, content.replace("## Output", "## Result"), "utf8");

    const report = await validateAgentKit(kit, "local-valid");

    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "skill.section.missing",
        message: "Missing required SKILL.md section: ## Output"
      })
    );
  });

  test("valid-local fails publishable without README.md and LICENSE", async () => {
    const report = await validateAgentKit(path.join(fixturesRoot, "valid-local"), "publishable");

    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["README.md", "LICENSE"])
    );
  });

  test("valid-publishable fails trusted without trusted requirements", async () => {
    const report = await validateAgentKit(
      path.join(fixturesRoot, "valid-publishable"),
      "trusted"
    );

    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["CHANGELOG.md", "policies", "examples"])
    );
  });

  test("valid-trusted fails verified without evals", async () => {
    const report = await validateAgentKit(path.join(fixturesRoot, "valid-trusted"), "verified");

    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        path: "evals"
      })
    );
  });

  test("reports undeclared scripts", async () => {
    const kit = await copyFixture();
    await mkdir(path.join(kit, "scripts"));
    await writeFile(path.join(kit, "scripts", "setup.sh"), "#!/usr/bin/env bash\n", "utf8");

    const report = await validateAgentKit(kit, "local-valid");

    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "scripts.undeclared",
        path: "scripts/setup.sh"
      })
    );
  });

  test("exports a one-file Markdown bundle", async () => {
    const kit = await copyFixture();
    await mkdir(path.join(kit, "workflows"));
    await writeFile(path.join(kit, "workflows", "review.md"), "# Review Workflow\n", "utf8");
    const out = path.join(kit, "exports", "bundle.md");
    await mkdir(path.dirname(out));

    await exportOneFile(kit, out);
    const content = await readFile(out, "utf8");

    expect(content).toContain("<!-- BEGIN START_HERE.md -->");
    expect(content).toContain("<!-- BEGIN AGENTKIT.md -->");
    expect(content).toContain("<!-- BEGIN skills/summarize/SKILL.md -->");
    expect(content).toContain("<!-- BEGIN workflows/review.md -->");
  });

  test("creates a .agentkit.zip package", async () => {
    const kit = await copyFixture();
    const out = path.join(kit, "valid-local.agentkit.zip");

    await packageAgentKit(kit, out);
    const zip = await readFile(out);

    expect(zip.byteLength).toBeGreaterThan(0);
    expect(zip.subarray(0, 2).toString("utf8")).toBe("PK");
  });
});

async function copyFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentkitforge-core-"));
  await cp(fixtureRoot, root, { recursive: true });
  return root;
}
