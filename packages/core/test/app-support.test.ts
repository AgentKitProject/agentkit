import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  getDefaultOneFileName,
  getDefaultOutputName,
  getDefaultPackageName,
  sanitizeArtifactName
} from "../src/artifacts/naming.js";
import { createAgentKitDraftRequest } from "../src/builder/draftRequest.js";
import { createAgentKitDraftRevisionRequest } from "../src/builder/revisionRequest.js";
import { createCliProgram } from "../src/cli/program.js";
import { renderAgentKitDraft } from "../src/draft/render.js";
import {
  inferExampleInputDocumentKind,
  isSupportedExampleInputDocument
} from "../src/app/exampleInputDocuments.js";
import { inspectAgentKitCandidate } from "../src/app/inspect.js";
import { loadAgentKitAsDraft } from "../src/app/loadAsDraft.js";
import { getAgentKitSummary } from "../src/app/summary.js";
import { createAgentKit } from "../src/init/create.js";
import { validateAgentKit } from "../src/validation/validator.js";

describe("app support helpers", () => {
  test("inspectAgentKitCandidate valid kit candidate", async () => {
    const kit = await createKitWithPrompt();
    const result = await inspectAgentKitCandidate(kit);

    expect(result.exists).toBe(true);
    expect(result.isDirectory).toBe(true);
    expect(result.looksLikeAgentKit).toBe(true);
    expect(result.foundSkills).toContain("first-skill");
    expect(result.validationReport?.valid).toBe(true);
  });

  test("inspectAgentKitCandidate missing agentkit.yaml", async () => {
    const kit = await createKitWithPrompt();
    await rm(path.join(kit, "agentkit.yaml"));

    const result = await inspectAgentKitCandidate(kit);

    expect(result.looksLikeAgentKit).toBe(false);
    expect(result.missingRequiredFiles).toContain("agentkit.yaml");
  });

  test("inspectAgentKitCandidate missing skills folder", async () => {
    const kit = await createKitWithPrompt();
    await rm(path.join(kit, "skills"), { recursive: true });

    const result = await inspectAgentKitCandidate(kit);

    expect(result.missingRequiredFolders).toContain("skills");
    expect(result.missingRequiredFiles).toContain("skills/<skill-id>/SKILL.md");
  });

  test("inspectAgentKitCandidate folder does not exist", async () => {
    const result = await inspectAgentKitCandidate(path.join(await tempDir(), "missing"));

    expect(result.exists).toBe(false);
    expect(result.looksLikeAgentKit).toBe(false);
  });

  test("inspectAgentKitCandidate folder exists but is not an Agent Kit", async () => {
    const folder = await tempDir();
    await writeFile(path.join(folder, "package.json"), "{}", "utf8");

    const result = await inspectAgentKitCandidate(folder);

    expect(result.looksLikeAgentKit).toBe(false);
    expect(result.friendlySummary).toContain("does not look like an Agent Kit");
  });

  test("friendly missing-file summary is useful", async () => {
    const folder = await tempDir();
    const result = await inspectAgentKitCandidate(folder);

    expect(result.friendlySummary).toContain("agentkit.yaml");
    expect(result.friendlySummary).toContain("select a subfolder");
  });

  test("getAgentKitSummary includes skills, prompts, policies, and examples", async () => {
    const kit = await createKitWithPrompt();
    await mkdir(path.join(kit, "policies"));
    await writeFile(path.join(kit, "policies", "usage.yaml"), "id: usage\nrules:\n  - Be careful.\n", "utf8");
    await mkdir(path.join(kit, "examples", "prompts"), { recursive: true });
    await writeFile(path.join(kit, "examples", "prompts", "sample.md"), "# Sample\n", "utf8");

    const summary = await getAgentKitSummary(kit);

    expect(summary.id).toBe("prompt-kit");
    expect(summary.counts.skills).toBe(1);
    expect(summary.counts.preparedPrompts).toBe(1);
    expect(summary.counts.policies).toBe(1);
    expect(summary.counts.examples).toBe(1);
  });

  test("loadAgentKitAsDraft loads simple kit and prepared prompts", async () => {
    const kit = await createKitWithPrompt();
    const result = await loadAgentKitAsDraft(kit);

    expect(result.draft.id).toBe("prompt-kit");
    expect(result.draft.skills).toHaveLength(1);
    expect(result.draft.preparedPrompts).toHaveLength(1);
    expect(result.sourceFiles).toContain("prompts/financial-review.yaml");
  });

  test("loaded draft can be rendered back into a valid kit", async () => {
    const kit = await createKitWithPrompt();
    const result = await loadAgentKitAsDraft(kit);
    const out = await tempDir();

    await renderAgentKitDraft(result.draft, out);

    expect((await validateAgentKit(out, "local-valid")).valid).toBe(true);
  });

  test("loadAgentKitAsDraft returns warnings for unsupported sections", async () => {
    const kit = await createKitWithPrompt();
    await mkdir(path.join(kit, "references"));
    await writeFile(path.join(kit, "references", "note.md"), "# Reference\n", "utf8");

    const result = await loadAgentKitAsDraft(kit);

    expect(result.warnings.join("\n")).toContain("References are not fully represented");
  });

  test("draft request includes requested and excluded sections", () => {
    const request = createAgentKitDraftRequest({
      userRequest: "Build a finance kit.",
      requestedSections: ["skills", "preparedPrompts"],
      excludedSections: ["scripts"]
    });

    expect(request.userPrompt).toContain("Requested sections");
    expect(request.userPrompt).toContain("preparedPrompts");
    expect(request.userPrompt).toContain("Excluded sections");
    expect(request.userPrompt).toContain("scripts");
  });

  test("revision request includes section guidance", () => {
    const request = createAgentKitDraftRevisionRequest({
      currentDraft: minimalDraft(),
      changeRequest: "Add prepared prompts.",
      requestedSections: ["preparedPrompts"],
      excludedSections: ["scripts"]
    });

    expect(request.userPrompt).toContain("Generate requested sections");
    expect(request.userPrompt).toContain("Do not generate scripts unless scripts are explicitly requested");
  });

  test("scripts excluded by default unless requested", () => {
    const request = createAgentKitDraftRequest({
      userRequest: "Build a finance kit."
    });

    expect(request.userPrompt).toContain("Do not generate scripts unless scripts are explicitly requested");
  });

  test("example input document helpers and request summaries", () => {
    expect(isSupportedExampleInputDocument("sample.xlsx")).toBe(true);
    expect(inferExampleInputDocumentKind("sample.csv")).toBe("csv");
    expect(isSupportedExampleInputDocument("sample.exe")).toBe(false);

    const request = createAgentKitDraftRequest({
      userRequest: "Build a finance kit.",
      exampleInputDocuments: [
        {
          id: "sample",
          name: "Example input document",
          filename: "sample.csv",
          kind: "csv",
          notes: "Monthly workbook export."
        }
      ]
    });

    expect(request.userPrompt).toContain("Example input document summaries");
    expect(request.userPrompt).toContain("sample.csv");
  });

  test("revision request includes example input document summaries", () => {
    const request = createAgentKitDraftRevisionRequest({
      currentDraft: minimalDraft(),
      changeRequest: "Use this sample.",
      exampleInputDocuments: [
        {
          id: "sample",
          name: "Example input document",
          filename: "sample.md",
          kind: "markdown"
        }
      ]
    });

    expect(request.userPrompt).toContain("Example input document summaries");
    expect(request.userPrompt).toContain("sample.md");
  });

  test("artifact naming helpers", () => {
    const metadata = { id: "Finance Kit!", version: "0.1.0 beta" };
    expect(sanitizeArtifactName("Finance Kit!")).toBe("finance-kit");
    expect(getDefaultOneFileName(metadata)).toBe("finance-kit-0.1.0-beta.onefile.md");
    expect(getDefaultPackageName({ id: "finance-kit" })).toBe("finance-kit-0.1.0.agentkit.zip");
    expect(getDefaultOutputName({ id: "finance-kit" }, new Date("2026-01-02T03:04:05.000Z"))).toBe(
      "finance-kit-output-20260102T030405Z.md"
    );
  });

  test("CLI inspect, summarize, and load-as-draft", async () => {
    const kit = await createKitWithPrompt();
    const inspect = JSON.parse(await runCommand(["inspect", kit])) as { looksLikeAgentKit: boolean };
    const summary = JSON.parse(await runCommand(["summarize", kit])) as { counts: { preparedPrompts: number } };
    const out = path.join(await tempDir(), "draft.json");

    await runCommand(["load-as-draft", kit, "--out", out]);
    const loaded = JSON.parse(await readFile(out, "utf8")) as { draft: { id: string } };

    expect(inspect.looksLikeAgentKit).toBe(true);
    expect(summary.counts.preparedPrompts).toBe(1);
    expect(loaded.draft.id).toBe("prompt-kit");
  });
});

function minimalDraft() {
  return {
    id: "minimal",
    name: "Minimal",
    description: "Minimal draft.",
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
    ]
  };
}

async function createKitWithPrompt(): Promise<string> {
  const kit = await tempDir();
  await createAgentKit(kit, {
    template: "blank",
    id: "prompt-kit",
    name: "Prompt Kit",
    description: "Kit with prompt."
  });
  await mkdir(path.join(kit, "prompts"));
  await writeFile(path.join(kit, "prompts", "financial-review.yaml"), promptYaml(), "utf8");
  await writeFile(
    path.join(kit, "agentkit.yaml"),
    `${await readFile(path.join(kit, "agentkit.yaml"), "utf8")}
prompts:
  - id: financial-review
    path: prompts/financial-review.yaml
    description: Review a financial workbook.
`,
    "utf8"
  );
  return kit;
}

function promptYaml(): string {
  return `id: financial-review
name: Financial Review
description: Review a financial workbook.
template: "Review {{company_name}}."
inputs:
  - id: company_name
    label: Company name
    type: short-text
    required: true
documentLikeOutput: true
`;
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentkitforge-app-support-"));
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
