import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createCliProgram } from "../src/cli/program.js";
import { buildAgentKitContext } from "../src/context/builder.js";
import { renderAgentKitDraft } from "../src/draft/render.js";
import { exportOneFile } from "../src/export/onefile.js";
import { createAgentKit } from "../src/init/create.js";
import {
  extractPromptVariables,
  findUnresolvedPromptVariables,
  getDefaultArtifactNames,
  listPreparedPrompts,
  renderPreparedPrompt,
  renderPreparedPromptWithValidation,
  validatePreparedPromptInputs
} from "../src/prompts/prompts.js";
import { preparedPromptSchema } from "../src/prompts/schema.js";
import { validateAgentKit } from "../src/validation/validator.js";
import { findMatchingDomains, getKnownDomains } from "../src/domains/catalog.js";

describe("Prepared Prompts", () => {
  test("valid prepared prompt schema", () => {
    expect(preparedPromptSchema.safeParse(preparedPromptFixture()).success).toBe(true);
  });

  test("invalid prepared prompt schema", () => {
    expect(preparedPromptSchema.safeParse({ id: "Bad Id", template: "" }).success).toBe(false);
  });

  test("listPreparedPrompts", async () => {
    const kit = await createKitWithPrompt();
    const prompts = await listPreparedPrompts(kit);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.id).toBe("financial-review");
  });

  test("renderPreparedPrompt with required inputs", async () => {
    const prompt = (await listPreparedPrompts(await createKitWithPrompt()))[0];

    const rendered = renderPreparedPrompt(prompt, {
      company_name: "Acme",
      reporting_period: "Q1",
      review_focus: "formulas",
      output_style: "executive"
    });

    expect(rendered).toContain("Review Acme's financial workbook for Q1");
    expect(rendered).toContain("return a executive summary");
  });

  test("renderPreparedPrompt missing required input fails clearly", async () => {
    const prompt = (await listPreparedPrompts(await createKitWithPrompt()))[0];

    expect(() =>
      renderPreparedPrompt(prompt, {
        company_name: "Acme"
      })
    ).toThrow("Missing required prompt input: reporting_period");
  });

  test("renderPreparedPrompt with optional input", async () => {
    const prompt = {
      ...preparedPromptFixture(),
      template: "Summarize {{company_name}} {{optional_note}}.",
      inputs: [
        {
          id: "company_name",
          label: "Company",
          type: "short-text" as const,
          required: true
        },
        {
          id: "optional_note",
          label: "Optional note",
          type: "short-text" as const,
          required: false
        }
      ]
    };

    expect(renderPreparedPrompt(prompt, { company_name: "Acme" })).toBe("Summarize Acme .");
  });

  test("extractPromptVariables", () => {
    expect(extractPromptVariables("Review {{company_name}} for {{ reporting_period }}.")).toEqual([
      "company_name",
      "reporting_period"
    ]);
  });

  test("manifest prompt path validation", async () => {
    const kit = await createKitWithPrompt();
    await writeFile(path.join(kit, "agentkit.yaml"), baseManifestWithPrompt("missing.yaml"), "utf8");

    const report = await validateAgentKit(kit, "local-valid");

    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "manifest.prompt_path.missing"
      })
    );
  });

  test("one-file export includes prepared prompts", async () => {
    const kit = await createKitWithPrompt();
    const out = path.join(await tempDir(), "onefile.md");

    await exportOneFile(kit, out);
    const content = await readFile(out, "utf8");

    expect(content).toContain("## Prepared Prompts");
    expect(content).toContain("### Financial Review Prompt");
    expect(content).toContain("{{company_name}}");
  });

  test("draft renderer writes prompt files", async () => {
    const kit = await tempDir();

    await renderAgentKitDraft(
      {
        id: "draft-with-prompt",
        name: "Draft With Prompt",
        description: "Draft with prepared prompt.",
        skills: [
          {
            id: "summarize",
            name: "Summarize",
            description: "Summarize text.",
            triggers: ["summarize"],
            useWhen: "Use when summarizing.",
            procedure: "Read and summarize.",
            output: "Markdown."
          }
        ],
        preparedPrompts: [preparedPromptFixture()]
      },
      kit
    );

    await expect(readFile(path.join(kit, "prompts", "financial-review.yaml"), "utf8")).resolves.toContain(
      "documentLikeOutput: true"
    );
    await expect(readFile(path.join(kit, "agentkit.yaml"), "utf8")).resolves.toContain("prompts:");
  });

  test("context builder can include prompts", async () => {
    const kit = await createKitWithPrompt();

    const context = await buildAgentKitContext({
      kitPath: kit,
      mode: "all",
      target: "generic",
      includePrompts: true
    });

    expect(context.includedFiles).toContain("prompts/financial-review.yaml");
    expect(context.systemContext).toContain("--- FILE: prompts/financial-review.yaml ---");
  });

  test("artifact naming helpers", () => {
    expect(
      getDefaultArtifactNames({
        id: "finance-kit",
        version: "0.1.0",
        timestamp: new Date("2026-01-02T03:04:05.000Z")
      })
    ).toEqual({
      onefile: "finance-kit-0.1.0.onefile.md",
      package: "finance-kit-0.1.0.agentkit.zip",
      output: "finance-kit-output-20260102T030405Z.md"
    });
  });

  test("domain catalog lookup", () => {
    expect(getKnownDomains().map((domain) => domain.label)).toContain("Finance / Accounting");
    expect(findMatchingDomains("finance")[0]?.id).toBe("finance-accounting");
  });

  test("CLI list-prompts", async () => {
    const kit = await createKitWithPrompt();
    const output = await runCommand(["list-prompts", kit]);
    const prompts = JSON.parse(output) as Array<{ id: string }>;

    expect(prompts[0]?.id).toBe("financial-review");
  });

  test("CLI render-prompt", async () => {
    const kit = await createKitWithPrompt();
    const inputs = await writeInputs();
    const output = await runCommand([
      "render-prompt",
      kit,
      "financial-review",
      "--inputs",
      inputs
    ]);

    expect(output).toContain("Review Acme's financial workbook");
  });

  test("CLI validate-prompt-inputs", async () => {
    const kit = await createKitWithPrompt();
    const inputs = await writeInputs();
    const output = await runCommand([
      "validate-prompt-inputs",
      kit,
      "financial-review",
      "--inputs",
      inputs
    ]);
    const report = JSON.parse(output) as { valid: boolean };

    expect(report.valid).toBe(true);
  });

  test("validatePreparedPromptInputs returns invalid report", async () => {
    const prompt = (await listPreparedPrompts(await createKitWithPrompt()))[0];

    expect(validatePreparedPromptInputs(prompt, {}).valid).toBe(false);
  });

  test("double-brace replacement", () => {
    expect(
      renderPreparedPrompt(simplePrompt("Review {{company_name}} for {{reporting_period}}."), {
        company_name: "Amazon",
        reporting_period: "Q1 2024"
      })
    ).toBe("Review Amazon for Q1 2024.");
  });

  test("single-brace replacement", () => {
    expect(
      renderPreparedPrompt(simplePrompt("Review {company_name} for {reporting_period}."), {
        company_name: "Amazon",
        reporting_period: "Q1 2024"
      })
    ).toBe("Review Amazon for Q1 2024.");
  });

  test("whitespace replacement", () => {
    expect(
      renderPreparedPrompt(simplePrompt("Review {{ company_name }} for { reporting_period }."), {
        company_name: "Amazon",
        reporting_period: "Q1 2024"
      })
    ).toBe("Review Amazon for Q1 2024.");
  });

  test("mixed syntax replacement", () => {
    expect(
      renderPreparedPrompt(simplePrompt("{company_name} summary for {{reporting_period}}"), {
        company_name: "Amazon",
        reporting_period: "Q1 2024"
      })
    ).toBe("Amazon summary for Q1 2024");
  });

  test("missing required input lists missing variable", () => {
    const result = renderPreparedPromptWithValidation(
      simplePrompt("Review {{company_name}} for {{reporting_period}}."),
      { company_name: "Amazon" }
    );

    expect(result.valid).toBe(false);
    expect(result.missingInputs).toContain("reporting_period");
    expect(result.unresolvedVariables).toContain("reporting_period");
    expect(() =>
      renderPreparedPrompt(simplePrompt("Review {{company_name}} for {{reporting_period}}."), {
        company_name: "Amazon"
      })
    ).toThrow("reporting_period");
  });

  test("undefined placeholder is reported", () => {
    const prompt = {
      ...simplePrompt("Review {{company_name}} for {{unknown_field}}."),
      inputs: [
        {
          id: "company_name",
          label: "Company name",
          type: "short-text" as const,
          required: true
        }
      ]
    };
    const report = validatePreparedPromptInputs(prompt, { company_name: "Amazon" });
    const result = renderPreparedPromptWithValidation(prompt, { company_name: "Amazon" });

    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "prompt.placeholder.undefined",
        path: "unknown_field"
      })
    );
    expect(result.unresolvedVariables).toContain("unknown_field");
  });

  test("no unresolved placeholders after successful render", () => {
    const rendered = renderPreparedPrompt(simplePrompt("Review {{company_name}} for {{reporting_period}}."), {
      company_name: "Amazon",
      reporting_period: "Q1 2024"
    });

    expect(findUnresolvedPromptVariables(rendered)).toEqual([]);
  });

  test("regression: Amazon Q1 inputs do not leave placeholders", () => {
    const rendered = renderPreparedPrompt(simplePrompt("Review {company_name} for {{reporting_period}}."), {
      company_name: "Amazon",
      reporting_period: "Q1 2024"
    });

    expect(rendered).toBe("Review Amazon for Q1 2024.");
    expect(rendered).not.toContain("{company_name}");
    expect(rendered).not.toContain("{reporting_period}");
    expect(rendered).not.toContain("{{company_name}}");
    expect(rendered).not.toContain("{{reporting_period}}");
  });
});

function preparedPromptFixture() {
  return {
    id: "financial-review",
    name: "Financial Review Prompt",
    description: "Review a financial workbook and produce a summary.",
    template:
      "Review {{company_name}}'s financial workbook for {{reporting_period}}. Focus on {{review_focus}} and return a {{output_style}} summary.",
    inputs: [
      {
        id: "company_name",
        label: "Company name",
        type: "short-text" as const,
        required: true
      },
      {
        id: "reporting_period",
        label: "Reporting period",
        type: "short-text" as const,
        required: true
      },
      {
        id: "review_focus",
        label: "Review focus",
        type: "long-text" as const,
        required: true
      },
      {
        id: "output_style",
        label: "Output style",
        type: "choice" as const,
        required: true,
        choices: ["executive", "detailed"],
        defaultValue: "executive"
      }
    ],
    outputMode: "markdown" as const,
    documentLikeOutput: true,
    suggestedFileName: "{{company_name}}-financial-review",
    tags: ["finance"]
  };
}

function simplePrompt(template: string) {
  return {
    id: "simple",
    name: "Simple",
    description: "Simple prompt.",
    template,
    inputs: [
      {
        id: "company_name",
        label: "Company name",
        type: "short-text" as const,
        required: true
      },
      {
        id: "reporting_period",
        label: "Reporting period",
        type: "short-text" as const,
        required: true
      }
    ]
  };
}

async function createKitWithPrompt(): Promise<string> {
  const kit = await tempDir();
  await createAgentKit(kit, {
    template: "blank",
    id: "prompt-kit",
    name: "Prompt Kit",
    description: "Kit with a prepared prompt."
  });
  await mkdir(path.join(kit, "prompts"));
  await writeFile(path.join(kit, "prompts", "financial-review.yaml"), promptYaml(), "utf8");
  await writeFile(path.join(kit, "agentkit.yaml"), baseManifestWithPrompt("prompts/financial-review.yaml"), "utf8");
  return kit;
}

function baseManifestWithPrompt(promptPath: string): string {
  return `schemaVersion: "0.1"
kind: AgentKit
id: prompt-kit
name: Prompt Kit
version: "0.1.0"
description: Kit with a prepared prompt.
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
  - id: first-skill
    path: skills/first-skill/SKILL.md
    description: First starter skill.
    triggers:
      - first skill
prompts:
  - id: financial-review
    path: ${promptPath}
    description: Review a financial workbook and produce a summary.
`;
}

function promptYaml(): string {
  return `id: financial-review
name: Financial Review Prompt
description: Review a financial workbook and produce a summary.
template: "Review {{company_name}}'s financial workbook for {{reporting_period}}. Focus on {{review_focus}} and return a {{output_style}} summary."
inputs:
  - id: company_name
    label: Company name
    type: short-text
    required: true
  - id: reporting_period
    label: Reporting period
    type: short-text
    required: true
  - id: review_focus
    label: Review focus
    type: long-text
    required: true
  - id: output_style
    label: Output style
    type: choice
    required: true
    choices:
      - executive
      - detailed
    defaultValue: executive
outputMode: markdown
documentLikeOutput: true
suggestedFileName: "{{company_name}}-financial-review"
tags:
  - finance
`;
}

async function writeInputs(): Promise<string> {
  const file = path.join(await tempDir(), "inputs.json");
  await writeFile(
    file,
    JSON.stringify({
      company_name: "Acme",
      reporting_period: "Q1",
      review_focus: "formulas",
      output_style: "executive"
    }),
    "utf8"
  );
  return file;
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentkitforge-prompts-"));
}

async function runCommand(args: string[]): Promise<string> {
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
    await program.parseAsync(args, { from: "user" });
    return output;
  } finally {
    console.log = originalLog;
  }
}
