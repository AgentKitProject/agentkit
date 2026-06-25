import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createAgentKitDraftRevisionRequest } from "../src/builder/revisionRequest.js";
import { createCliProgram } from "../src/cli/program.js";
import {
  addDraftRevision,
  createDraftSession,
  getCurrentDraftRevision,
  restoreDraftRevision
} from "../src/draft/session.js";
import type { AgentKitDraft } from "../src/draft/schema.js";

describe("Agent Kit draft sessions", () => {
  test("createDraftSession creates v1 session", () => {
    const session = createDraftSession({
      originalRequest: "Build a finance kit.",
      initialDraft: baseDraft(),
      provider: "openai",
      model: "gpt-test",
      now: new Date("2026-01-01T00:00:00.000Z")
    });

    expect(session.revisions).toHaveLength(1);
    expect(session.revisions[0]?.version).toBe(1);
    expect(session.currentRevisionId).toBe(session.revisions[0]?.id);
    expect(session.revisions[0]?.draft.id).toBe("finance-kit");
  });

  test("addDraftRevision increments version and updates current revision", () => {
    const session = createDraftSession({
      originalRequest: "Build a finance kit.",
      initialDraft: baseDraft(),
      now: new Date("2026-01-01T00:00:00.000Z")
    });

    const updated = addDraftRevision(session, {
      draft: { ...baseDraft(), name: "Finance Kit V2" },
      changeRequest: "Rename it.",
      now: new Date("2026-01-02T00:00:00.000Z")
    });

    expect(updated.revisions).toHaveLength(2);
    expect(updated.revisions[1]?.version).toBe(2);
    expect(updated.currentRevisionId).toBe(updated.revisions[1]?.id);
    expect(updated.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  test("restoreDraftRevision restores current revision", () => {
    const session = createDraftSession({
      originalRequest: "Build a finance kit.",
      initialDraft: baseDraft(),
      now: new Date("2026-01-01T00:00:00.000Z")
    });
    const updated = addDraftRevision(session, {
      draft: { ...baseDraft(), name: "Finance Kit V2" },
      now: new Date("2026-01-02T00:00:00.000Z")
    });

    const restored = restoreDraftRevision(
      updated,
      session.revisions[0]?.id ?? "",
      new Date("2026-01-03T00:00:00.000Z")
    );

    expect(restored.currentRevisionId).toBe(session.revisions[0]?.id);
    expect(restored.updatedAt).toBe("2026-01-03T00:00:00.000Z");
  });

  test("getCurrentDraftRevision returns expected draft", () => {
    const session = createDraftSession({
      originalRequest: "Build a finance kit.",
      initialDraft: baseDraft()
    });

    expect(getCurrentDraftRevision(session).draft.name).toBe("Finance Kit");
  });

  test("createAgentKitDraftRevisionRequest includes current draft and change request", () => {
    const request = createAgentKitDraftRevisionRequest({
      currentDraft: baseDraft(),
      changeRequest: "Add a reusable prepared prompt.",
      originalRequest: "Build a finance kit.",
      desiredValidationLevel: "trusted"
    });

    expect(request.input.currentDraft.id).toBe("finance-kit");
    expect(request.userPrompt).toContain("Add a reusable prepared prompt.");
    expect(request.userPrompt).toContain('"id": "finance-kit"');
  });

  test("revision request instructs AI to return full updated draft, not patch", () => {
    const request = createAgentKitDraftRevisionRequest({
      currentDraft: baseDraft(),
      changeRequest: "Make it more detailed."
    });

    expect(request.systemInstructions).toContain("Return only the full updated AgentKitDraft JSON");
    expect(request.systemInstructions).toContain("Do not return a patch");
    expect(request.userPrompt).toContain("Do not return a patch");
  });

  test("revision request schema matches AgentKitDraft", () => {
    const request = createAgentKitDraftRevisionRequest({
      currentDraft: baseDraft(),
      changeRequest: "Make it more detailed."
    });

    expect(request.expectedJsonSchema).toEqual(
      expect.objectContaining({
        title: "AgentKitDraft",
        type: "object",
        properties: expect.objectContaining({
          skills: expect.any(Object),
          preparedPrompts: expect.any(Object)
        })
      })
    );
  });

  test("revision request includes prepared prompt preservation guidance", () => {
    const request = createAgentKitDraftRevisionRequest({
      currentDraft: draftWithPreparedPrompt(),
      changeRequest: "Change the tone."
    });

    expect(request.userPrompt).toContain("Preserve prepared prompts");
    expect(request.warnings.join("\n")).toContain("preparedPrompts");
  });

  test("CLI draft-revision-request writes request JSON", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "agentkitforge-revision-"));
    const draftPath = path.join(tmp, "draft.json");
    const outPath = path.join(tmp, "revision-request.json");
    await writeFile(draftPath, JSON.stringify(draftWithPreparedPrompt()), "utf8");

    await runCommand([
      "draft-revision-request",
      draftPath,
      "--change",
      "Add one more prompt input.",
      "--original-request",
      "Build a finance kit.",
      "--level",
      "trusted",
      "--out",
      outPath
    ]);
    const request = JSON.parse(await readFile(outPath, "utf8")) as {
      responseFormatName: string;
      userPrompt: string;
      input: { currentDraft: AgentKitDraft; changeRequest: string };
    };

    expect(request.responseFormatName).toBe("agent_kit_draft_revision");
    expect(request.input.currentDraft.preparedPrompts).toHaveLength(1);
    expect(request.input.changeRequest).toBe("Add one more prompt input.");
    expect(request.userPrompt).toContain("Return the full updated AgentKitDraft JSON");
  });
});

function baseDraft(): AgentKitDraft {
  return {
    schemaVersion: "0.1",
    id: "finance-kit",
    name: "Finance Kit",
    version: "0.1.0",
    description: "Review finance workbooks.",
    author: { name: "Test" },
    license: "MIT",
    setupLevel: "low",
    compatibilityTargets: ["codex"],
    riskLevel: "low",
    skills: [
      {
        id: "summarize",
        name: "Summarize",
        description: "Summarize text.",
        triggers: ["summarize"],
        riskLevel: "low",
        useWhen: "Use when summarizing.",
        procedure: "Read and summarize.",
        output: "Markdown."
      }
    ],
    policies: [],
    examples: [],
    templates: [],
    preparedPrompts: []
  };
}

function draftWithPreparedPrompt(): AgentKitDraft {
  return {
    ...baseDraft(),
    preparedPrompts: [
      {
        id: "financial-review",
        name: "Financial Review",
        description: "Review a workbook.",
        template: "Review {{company_name}} for {{reporting_period}}.",
        inputs: [
          {
            id: "company_name",
            label: "Company name",
            type: "short-text",
            required: true,
            includeInPrompt: true
          },
          {
            id: "reporting_period",
            label: "Reporting period",
            type: "short-text",
            required: true,
            includeInPrompt: true
          }
        ],
        outputMode: "markdown",
        documentLikeOutput: true
      }
    ]
  };
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
