import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createAgentKitDraftRequest } from "../src/builder/draftRequest.js";
import { createCliProgram } from "../src/cli/program.js";

describe("Agent Kit draft request builder", () => {
  test("returns builder instructions", () => {
    const request = createAgentKitDraftRequest({
      userRequest: "Build a financial review kit."
    });

    expect(request.builderInstructions).toContain("# Create Agent Kit Draft");
    expect(request.systemInstructions).toContain("provider-neutral");
    expect(request.responseFormatName).toBe("agent_kit_draft");
  });

  test("includes the user request", () => {
    const request = createAgentKitDraftRequest({
      userRequest: "Build a financial review kit.",
      domain: "Finance",
      targetUsers: ["analysts"]
    });

    expect(request.userPrompt).toContain("Build a financial review kit.");
    expect(request.userPrompt).toContain("Domain: Finance");
    expect(request.userPrompt).toContain("- analysts");
  });

  test("includes a JSON schema for AgentKitDraft", () => {
    const request = createAgentKitDraftRequest({
      userRequest: "Build a writing kit."
    });

    expect(request.expectedJsonSchema).toEqual(
      expect.objectContaining({
        type: "object",
        properties: expect.objectContaining({
          id: expect.any(Object),
          skills: expect.any(Object)
        })
      })
    );
  });

  test("trusted and verified levels produce validation guidance warnings", () => {
    const trusted = createAgentKitDraftRequest({
      userRequest: "Build a financial review kit.",
      desiredValidationLevel: "trusted"
    });
    expect(trusted.warnings.join("\n")).toContain("policies/");
    expect(trusted.warnings.join("\n")).toContain("examples/");

    const verified = createAgentKitDraftRequest({
      userRequest: "Build a financial review kit.",
      desiredValidationLevel: "verified"
    });
    expect(verified.warnings.join("\n")).toContain("evals/");
  });

  test("CLI writes the request JSON", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "agentkitforge-builder-"));
    const out = path.join(tmp, "draft-request.json");

    await runDraftRequestCommand([
      "--request",
      "Build a financial review kit.",
      "--domain",
      "Finance",
      "--target-user",
      "analyst",
      "--target-user",
      "controller",
      "--level",
      "trusted",
      "--out",
      out
    ]);

    const content = JSON.parse(await readFile(out, "utf8")) as {
      responseFormatName: string;
      userPrompt: string;
      expectedJsonSchema: unknown;
      warnings: string[];
    };

    expect(content.responseFormatName).toBe("agent_kit_draft");
    expect(content.userPrompt).toContain("Build a financial review kit.");
    expect(content.userPrompt).toContain("- analyst");
    expect(content.userPrompt).toContain("- controller");
    expect(content.expectedJsonSchema).toEqual(expect.any(Object));
    expect(content.warnings.join("\n")).toContain("policies/");
  });
});

async function runDraftRequestCommand(args: string[]): Promise<void> {
  const program = createCliProgram();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined
  });
  await program.parseAsync(["draft-request", ...args], { from: "user" });
}
