import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, test } from "vitest";
import { exportAgentKitToClaudeCode } from "../src/adapters/claudeCode.js";
import { exportAgentKitToCodex } from "../src/adapters/codex.js";
import { loadAgentKitAsDraft } from "../src/app/loadAsDraft.js";
import { buildAgentKitContext } from "../src/context/builder.js";
import { renderAgentKitDraft } from "../src/draft/render.js";
import { exportOneFile } from "../src/export/onefile.js";
import { assertSafeId, assertSafeRelativePath } from "../src/fs/safety.js";
import { createAgentKit } from "../src/init/create.js";
import { packageAgentKit } from "../src/package/packager.js";
import { validateAgentKit } from "../src/validation/validator.js";

describe("release-blocking filesystem hardening", () => {
  test("safe relative paths reject unsafe Windows and traversal forms", () => {
    for (const unsafePath of [
      "C:foo",
      "C:\\foo",
      "C:/foo",
      "\\\\server\\share\\file",
      "//server/share/file",
      "\\\\?\\C:\\foo",
      "//?/C:/foo",
      "nested/\0bad.md",
      "/absolute/file.md",
      "../escape.md"
    ]) {
      expect(() => assertSafeRelativePath(unsafePath), unsafePath).toThrow();
    }

    expect(() => assertSafeRelativePath("valid/path/file.md")).not.toThrow();
  });

  test("safe ids reject Windows reserved device names", () => {
    for (const unsafeId of ["con", "CON", "con.txt", "prn", "aux", "nul", "com1", "lpt1"]) {
      expect(() => assertSafeId(unsafeId), unsafeId).toThrow();
    }

    expect(() => assertSafeId("safe-id")).not.toThrow();
  });

  test("manifest skill path traversal fails validation", async () => {
    const kit = await createMinimalKit();
    await writeFile(path.join(kit, "agentkit.yaml"), manifest({ skillPath: "../outside/SKILL.md" }), "utf8");

    const report = await validateAgentKit(kit, "local-valid");

    expect(report.valid).toBe(false);
    expect(report.issues.some((issue) => issue.message.includes("safe relative path"))).toBe(true);
  });

  test("manifest prompt path traversal fails validation", async () => {
    const kit = await createMinimalKit();
    await writeFile(path.join(kit, "agentkit.yaml"), manifest({ promptPath: "../outside.yaml" }), "utf8");

    const report = await validateAgentKit(kit, "local-valid");

    expect(report.valid).toBe(false);
    expect(report.issues.some((issue) => issue.message.includes("safe relative path"))).toBe(true);
  });

  test("declared script path traversal fails validation", async () => {
    const kit = await createMinimalKit();
    await mkdir(path.join(kit, "scripts"));
    await writeFile(path.join(kit, "scripts", "ok.sh"), "echo ok\n", "utf8");
    await writeFile(path.join(kit, "agentkit.yaml"), manifest({ scripts: ["../outside.sh"] }), "utf8");

    const report = await validateAgentKit(kit, "local-valid");

    expect(report.valid).toBe(false);
    expect(report.issues.some((issue) => issue.message.includes("safe relative path"))).toBe(true);
  });

  test("absolute and Windows drive paths fail validation", async () => {
    const kit = await createMinimalKit();
    await writeFile(path.join(kit, "agentkit.yaml"), manifest({ skillPath: "/tmp/SKILL.md" }), "utf8");
    expect((await validateAgentKit(kit, "local-valid")).valid).toBe(false);

    await writeFile(path.join(kit, "agentkit.yaml"), manifest({ skillPath: "C:\\temp\\SKILL.md" }), "utf8");
    expect((await validateAgentKit(kit, "local-valid")).valid).toBe(false);
  });

  test("unsafe kit and skill ids fail validation", async () => {
    const kit = await createMinimalKit();
    await writeFile(path.join(kit, "agentkit.yaml"), manifest({ id: "../../escape" }), "utf8");
    expect((await validateAgentKit(kit, "local-valid")).valid).toBe(false);

    await writeFile(path.join(kit, "agentkit.yaml"), manifest({ id: "bad/slash" }), "utf8");
    expect((await validateAgentKit(kit, "local-valid")).valid).toBe(false);

    await writeFile(path.join(kit, "agentkit.yaml"), manifest({ skillId: "bad\\slash" }), "utf8");
    expect((await validateAgentKit(kit, "local-valid")).valid).toBe(false);
  });

  test("safe kebab-case ids pass validation", async () => {
    const kit = await createMinimalKit();
    const report = await validateAgentKit(kit, "local-valid");

    expect(report.valid).toBe(true);
  });

  test("Windows reserved kit and skill ids fail validation", async () => {
    const kit = await createMinimalKit();
    await writeFile(path.join(kit, "agentkit.yaml"), manifest({ id: "con" }), "utf8");
    expect((await validateAgentKit(kit, "local-valid")).valid).toBe(false);

    await writeFile(path.join(kit, "agentkit.yaml"), manifest({ skillId: "lpt1" }), "utf8");
    expect((await validateAgentKit(kit, "local-valid")).valid).toBe(false);
  });

  test("renderAgentKitDraft rejects unsafe template path", async () => {
    await expect(
      renderAgentKitDraft(
        {
          ...draft(),
          templates: [{ id: "bad-template", path: "../escape.md", content: "bad" }]
        },
        await tempDir()
      )
    ).rejects.toThrow("Invalid Agent Kit draft");
  });

  test("renderAgentKitDraft force mode removes stale files", async () => {
    const target = await tempDir();
    await writeFile(path.join(target, "stale.txt"), "stale\n", "utf8");

    await renderAgentKitDraft(draft(), target, { force: true });

    await expect(readFile(path.join(target, "stale.txt"), "utf8")).rejects.toThrow();
    expect((await validateAgentKit(target, "local-valid")).valid).toBe(true);
  });

  test("renderAgentKitDraft force mode refuses unsafe cleanup target", async () => {
    await expect(renderAgentKitDraft(draft(), process.cwd(), { force: true })).rejects.toThrow(
      "Refusing to clean current repository root"
    );
  });

  test("export-codex malicious ids fail safely", async () => {
    const kit = await createMinimalKit();
    const dest = await tempDir();
    await writeFile(path.join(kit, "agentkit.yaml"), manifest({ id: "../../escape" }), "utf8");
    await expect(exportAgentKitToCodex(kit, dest)).rejects.toThrow("agentkit.yaml is invalid");

    await writeFile(path.join(kit, "agentkit.yaml"), manifest({ skillId: "bad/slash" }), "utf8");
    await expect(exportAgentKitToCodex(kit, dest)).rejects.toThrow("agentkit.yaml is invalid");
  });

  test("export-claude-code malicious manifest id fails safely", async () => {
    const kit = await createMinimalKit();
    await writeFile(path.join(kit, "agentkit.yaml"), manifest({ id: "../../escape" }), "utf8");

    await expect(exportAgentKitToClaudeCode(kit, await tempDir())).rejects.toThrow(
      "agentkit.yaml is invalid"
    );
  });

  test("export force mode does not delete unrelated folders", async () => {
    const kit = await createMinimalKit();
    const dest = await tempDir();
    await mkdir(path.join(dest, "unrelated"));
    await writeFile(path.join(dest, "unrelated", "README.md"), "keep\n", "utf8");

    await exportAgentKitToCodex(kit, dest, { force: true });

    await expect(readFile(path.join(dest, "unrelated", "README.md"), "utf8")).resolves.toBe("keep\n");
  });

  test("package excludes exports and enforces max file count", async () => {
    const kit = await createMinimalKit();
    await mkdir(path.join(kit, "exports"));
    await writeFile(path.join(kit, "exports", "skip.md"), "skip\n", "utf8");
    const out = path.join(await tempDir(), "kit.agentkit.zip");

    await packageAgentKit(kit, out);
    const zip = await readFile(out);
    expect(zip.includes(Buffer.from("skip"))).toBe(false);
    await expect(packageAgentKit(kit, path.join(await tempDir(), "bad.zip"), { maxFiles: 1 })).rejects.toThrow(
      "File count limit exceeded"
    );
  });

  test("package rejects symlinks when supported by platform", async () => {
    const kit = await createMinimalKit();
    try {
      await symlink(path.join(kit, "AGENTKIT.md"), path.join(kit, "linked.md"));
    } catch {
      return;
    }

    await expect(packageAgentKit(kit, path.join(await tempDir(), "kit.zip"))).rejects.toThrow(
      "symbolic link"
    );
  });

  test("package zip entries use forward slashes", async () => {
    const kit = await createMinimalKit();
    const out = path.join(await tempDir(), "kit.agentkit.zip");

    await packageAgentKit(kit, out);

    const zip = await JSZip.loadAsync(await readFile(out));
    expect(Object.keys(zip.files)).toContain("skills/first-skill/SKILL.md");
    expect(Object.keys(zip.files).some((entry) => entry.includes("\\"))).toBe(false);
  });

  test("one-file export creates output parent directory", async () => {
    const kit = await createMinimalKit();
    const out = path.join(await tempDir(), "nested", "bundle.md");

    await exportOneFile(kit, out);

    await expect(readFile(out, "utf8")).resolves.toContain("<!-- BEGIN AGENTKIT.md -->");
  });

  test("one-file export rejects symlinks when supported by platform", async () => {
    const kit = await createMinimalKit();
    await mkdir(path.join(kit, "workflows"));
    try {
      await symlink(path.join(kit, "AGENTKIT.md"), path.join(kit, "workflows", "linked.md"));
    } catch {
      return;
    }

    await expect(exportOneFile(kit, path.join(await tempDir(), "bundle.md"))).rejects.toThrow("symbolic link");
  });

  test("loadAgentKitAsDraft rejects symlinks when supported by platform", async () => {
    const kit = await createMinimalKit();
    await mkdir(path.join(kit, "references"));
    try {
      await symlink(path.join(kit, "AGENTKIT.md"), path.join(kit, "references", "linked.md"));
    } catch {
      return;
    }

    await expect(loadAgentKitAsDraft(kit)).rejects.toThrow("symbolic link");
  });

  test("loadAgentKitAsDraft still loads a valid kit with safe traversal", async () => {
    const kit = await createMinimalKit();
    const result = await loadAgentKitAsDraft(kit);

    expect(result.draft.id).toBe("safe-kit");
    expect(result.draft.skills).toHaveLength(1);
  });

  test("context builder enforces max files and returns warnings", async () => {
    const kit = await createMinimalKit();
    await mkdir(path.join(kit, "policies"));
    await writeFile(path.join(kit, "policies", "a.md"), "a\n", "utf8");
    await writeFile(path.join(kit, "policies", "b.md"), "b\n", "utf8");

    const context = await buildAgentKitContext({
      kitPath: kit,
      mode: "all",
      target: "generic",
      includePolicies: true,
      maxFiles: 1
    });

    expect(context.warnings.some((warning) => warning.includes("File count limit exceeded"))).toBe(true);
  });
});

async function createMinimalKit(): Promise<string> {
  const kit = await tempDir();
  await createAgentKit(kit, {
    template: "blank",
    id: "safe-kit",
    name: "Safe Kit",
    description: "Safe kit."
  });
  return kit;
}

function manifest(options: {
  id?: string;
  skillId?: string;
  skillPath?: string;
  promptPath?: string;
  scripts?: string[];
} = {}): string {
  return `schemaVersion: "0.1"
kind: AgentKit
id: ${JSON.stringify(options.id ?? "safe-kit")}
name: Safe Kit
version: "0.1.0"
description: Safe kit.
author:
  name: Test
license: MIT
entrypoints:
  human: START_HERE.md
  agent: AGENTKIT.md
userExperience:
  setupLevel: low
compatibility:
  targets:
    - codex
risk:
  level: low
skills:
  - id: ${JSON.stringify(options.skillId ?? "first-skill")}
    path: ${JSON.stringify(options.skillPath ?? "skills/first-skill/SKILL.md")}
    description: First starter skill.
    triggers:
      - first skill
${options.promptPath ? `prompts:\n  - id: test-prompt\n    path: ${JSON.stringify(options.promptPath)}\n    description: Test prompt.\n` : ""}${options.scripts ? `scripts:\n${options.scripts.map((script) => `  - ${JSON.stringify(script)}`).join("\n")}\n` : ""}`;
}

function draft() {
  return {
    id: "safe-kit",
    name: "Safe Kit",
    description: "Safe draft.",
    skills: [
      {
        id: "first-skill",
        name: "First Skill",
        description: "First skill.",
        triggers: ["first skill"],
        useWhen: "Use when needed.",
        procedure: "Do it.",
        output: "Markdown."
      }
    ]
  };
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentkitforge-security-"));
}
