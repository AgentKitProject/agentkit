import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const cli = path.join(root, "dist", "cli", "index.js");
const tmp = mkdtempSync(path.join(tmpdir(), "agentkitforge-smoke-"));

function run(args, options = {}) {
  const label = `agentkitforge ${args.join(" ")}`;
  console.log(`\n> ${label}`);
  try {
    return execFileSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    });
  } catch (error) {
    console.error(`Smoke command failed: ${label}`);
    if (error.stdout) {
      console.error(String(error.stdout));
    }
    if (error.stderr) {
      console.error(String(error.stderr));
    }
    throw error;
  }
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

try {
  const blankKit = path.join(tmp, "blank-kit");
  const financialKit = path.join(tmp, "financial-review-kit");
  const packageFile = path.join(tmp, "financial-review.agentkit.zip");
  const oneFile = path.join(tmp, "financial-review.onefile.md");
  const contextFile = path.join(tmp, "context.json");
  const codexSkills = path.join(tmp, "codex-skills");
  const claudePlugins = path.join(tmp, "claude-code-plugins");
  const draftFile = path.join(tmp, "loaded-draft.json");
  const promptInputs = path.join(tmp, "prompt-inputs.json");
  const renderedPrompt = path.join(tmp, "rendered-prompt.md");

  run([
    "init",
    blankKit,
    "--template",
    "blank",
    "--id",
    "blank-smoke",
    "--name",
    "Blank Smoke",
    "--description",
    "Blank smoke test kit."
  ]);
  run(["validate", blankKit, "--profile", "local-valid"]);

  run([
    "init",
    financialKit,
    "--template",
    "financial-review",
    "--id",
    "financial-smoke",
    "--name",
    "Financial Smoke",
    "--description",
    "Financial review smoke test kit."
  ]);
  run(["validate", financialKit, "--profile", "trusted"]);

  await mkdir(path.join(financialKit, "prompts"), { recursive: true });
  writeFileSync(
    path.join(financialKit, "prompts", "financial-review.yaml"),
    `id: financial-review
name: Financial Review Prompt
description: Review a financial workbook.
template: "Review {{company_name}} for {{reporting_period}}."
inputs:
  - id: company_name
    label: Company name
    type: short-text
    required: true
  - id: reporting_period
    label: Reporting period
    type: short-text
    required: true
outputMode: markdown
documentLikeOutput: true
`,
    "utf8"
  );
  const manifestPath = path.join(financialKit, "agentkit.yaml");
  writeFileSync(
    manifestPath,
    `${readFileSync(manifestPath, "utf8")}
prompts:
  - id: financial-review
    path: prompts/financial-review.yaml
    description: Review a financial workbook.
`,
    "utf8"
  );
  writeJson(promptInputs, {
    company_name: "Amazon",
    reporting_period: "Q1 2024"
  });

  run(["package", financialKit, "--out", packageFile]);
  run(["export-onefile", financialKit, "--out", oneFile]);
  run(["list-prompts", financialKit]);
  run(["render-prompt", financialKit, "financial-review", "--inputs", promptInputs, "--out", renderedPrompt]);
  run([
    "build-context",
    financialKit,
    "--task",
    "Audit formulas in this workbook.",
    "--mode",
    "triggered",
    "--target",
    "generic",
    "--out",
    contextFile
  ]);
  run(["export-codex", financialKit, "--dest", codexSkills, "--force"]);
  run(["export-claude-code", financialKit, "--dest", claudePlugins, "--force"]);
  run(["inspect", financialKit]);
  run(["summarize", financialKit]);
  run(["load-as-draft", financialKit, "--out", draftFile]);

  console.log(`\nSmoke test completed successfully in ${tmp}`);
} finally {
  if (process.env.AGENTKITFORGE_KEEP_SMOKE_TMP !== "1") {
    await rm(tmp, { recursive: true, force: true });
  }
}
