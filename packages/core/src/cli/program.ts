import { Command } from "commander";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { exportAgentKitToClaudeCode } from "../adapters/claudeCode.js";
import { exportAgentKitToCodex } from "../adapters/codex.js";
import { inspectAgentKitCandidate } from "../app/inspect.js";
import { getAgentKitSummary } from "../app/summary.js";
import { loadAgentKitAsDraft } from "../app/loadAsDraft.js";
import { createAgentKitDraftRequest } from "../builder/draftRequest.js";
import { createAgentKitDraftRevisionRequest } from "../builder/revisionRequest.js";
import { buildAgentKitContext } from "../context/builder.js";
import type { AgentKitContextBuildMode, AgentKitContextTarget } from "../context/types.js";
import { renderAgentKitDraft } from "../draft/render.js";
import { agentKitDraftSchema } from "../draft/schema.js";
import { exportOneFile } from "../export/onefile.js";
import { createAgentKit } from "../init/create.js";
import type { AgentKitTemplateName } from "../init/templates.js";
import { packageAgentKit } from "../package/packager.js";
import {
  formatDisplayVersion,
  getAgentKitVersion,
  nextAgentKitVersion,
  setAgentKitVersion
} from "../package/version.js";
import {
  listPreparedPrompts,
  renderPreparedPrompt,
  validatePreparedPromptInputs
} from "../prompts/prompts.js";
import type { AgentKitValidationProfile } from "../types.js";
import { validateAgentKit } from "../validation/validator.js";
import { registerMarketCommands } from "./market.js";
import { registerGatewayCommands } from "./gateway.js";

const profiles = ["local-valid", "publishable", "trusted", "verified"];
const templateNames = ["blank", "financial-review"];
const contextModes = ["all", "triggered"];
const contextTargets = ["openai", "chatgpt", "claude", "generic"];

export function createCliProgram(): Command {
  const program = new Command()
    .name("agentkitforge")
    .description("AgentKitForge core CLI")
    .version("0.1.0");

  program
    .command("validate")
    .argument("<path>", "Agent Kit folder")
    .option("--profile <profile>", "Validation profile", "local-valid")
    .action(async (kitPath: string, options: { profile: string }) => {
      if (!profiles.includes(options.profile)) {
        throw new Error(`Invalid profile: ${options.profile}`);
      }

      const report = await validateAgentKit(
        kitPath,
        options.profile as AgentKitValidationProfile
      );

      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.valid ? 0 : 1;
    });

  program
    .command("inspect")
    .argument("<path>", "Folder to inspect")
    .action(async (inputPath: string) => {
      console.log(JSON.stringify(await inspectAgentKitCandidate(inputPath), null, 2));
    });

  program
    .command("summarize")
    .argument("<path>", "Agent Kit folder")
    .action(async (kitPath: string) => {
      console.log(JSON.stringify(await getAgentKitSummary(kitPath), null, 2));
    });

  program
    .command("load-as-draft")
    .argument("<path>", "Agent Kit folder")
    .requiredOption("--out <file>", "Output draft JSON file")
    .action(async (kitPath: string, options: { out: string }) => {
      const result = await loadAgentKitAsDraft(kitPath);
      const outPath = path.resolve(options.out);
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      console.log(outPath);
    });

  program
    .command("init")
    .argument("<path>", "New Agent Kit folder")
    .requiredOption("--template <template>", "Template name: blank|financial-review")
    .requiredOption("--id <id>", "Agent Kit id")
    .requiredOption("--name <name>", "Agent Kit name")
    .requiredOption("--description <description>", "Agent Kit description")
    .option("--force", "Allow initialization in a non-empty directory")
    .action(
      async (
        kitPath: string,
        options: {
          template: string;
          id: string;
          name: string;
          description: string;
          force?: boolean;
        }
      ) => {
        if (!templateNames.includes(options.template)) {
          throw new Error(`Invalid template: ${options.template}`);
        }

        const result = await createAgentKit(kitPath, {
          template: options.template as AgentKitTemplateName,
          id: options.id,
          name: options.name,
          description: options.description,
          force: options.force === true
        });

        console.log(JSON.stringify(result, null, 2));
      }
    );

  program
    .command("export-onefile")
    .argument("<path>", "Agent Kit folder")
    .requiredOption("--out <file>", "Output Markdown file")
    .action(async (kitPath: string, options: { out: string }) => {
      const outPath = await exportOneFile(kitPath, options.out);
      console.log(outPath);
    });

  program
    .command("render-draft")
    .argument("<draft-json-file>", "Agent Kit draft JSON file")
    .argument("<target-dir>", "Output Agent Kit folder")
    .option("--force", "Allow rendering into a non-empty directory")
    .action(
      async (
        draftJsonFile: string,
        targetDir: string,
        options: {
          force?: boolean;
        }
      ) => {
        const draftText = await readFile(draftJsonFile, "utf8");
        const draft = JSON.parse(draftText) as unknown;
        const result = await renderAgentKitDraft(draft, targetDir, {
          force: options.force === true
        });

        console.log(JSON.stringify(result, null, 2));
      }
    );

  program
    .command("draft-request")
    .requiredOption("--request <text>", "Natural language Agent Kit request")
    .requiredOption("--out <file>", "Output JSON request file")
    .option("--domain <domain>", "Domain or subject area")
    .option("--target-user <value>", "Target user. Repeat for multiple users.", collectValues, [])
    .option("--level <level>", "Desired validation level", "local-valid")
    .action(
      async (options: {
        request: string;
        out: string;
        domain?: string;
        targetUser: string[];
        level: string;
      }) => {
        if (!profiles.includes(options.level)) {
          throw new Error(`Invalid validation level: ${options.level}`);
        }

        const request = createAgentKitDraftRequest({
          userRequest: options.request,
          domain: options.domain,
          targetUsers: options.targetUser,
          desiredValidationLevel: options.level as AgentKitValidationProfile
        });
        const outPath = path.resolve(options.out);
        await mkdir(path.dirname(outPath), { recursive: true });
        await writeFile(outPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
        console.log(outPath);
      }
    );

  program
    .command("draft-revision-request")
    .argument("<current-draft-json-file>", "Current AgentKitDraft JSON file")
    .requiredOption("--change <text>", "Requested draft change")
    .requiredOption("--out <file>", "Output JSON revision request file")
    .option("--original-request <text>", "Original user request")
    .option("--level <level>", "Desired validation level", "local-valid")
    .action(
      async (
        currentDraftJsonFile: string,
        options: {
          change: string;
          out: string;
          originalRequest?: string;
          level: string;
        }
      ) => {
        if (!profiles.includes(options.level)) {
          throw new Error(`Invalid validation level: ${options.level}`);
        }

        const currentDraftInput = JSON.parse(await readFile(currentDraftJsonFile, "utf8")) as unknown;
        const currentDraft = agentKitDraftSchema.parse(currentDraftInput);
        const request = createAgentKitDraftRevisionRequest({
          currentDraft,
          changeRequest: options.change,
          originalRequest: options.originalRequest,
          desiredValidationLevel: options.level as AgentKitValidationProfile
        });
        const outPath = path.resolve(options.out);
        await mkdir(path.dirname(outPath), { recursive: true });
        await writeFile(outPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
        console.log(outPath);
      }
    );

  program
    .command("package")
    .argument("<path>", "Agent Kit folder")
    .requiredOption("--out <file>", "Output .agentkit.zip file")
    .action(async (kitPath: string, options: { out: string }) => {
      const outPath = await packageAgentKit(kitPath, options.out);
      console.log(outPath);
    });

  program
    .command("build-context")
    .argument("<kit-path>", "Agent Kit folder")
    .requiredOption("--out <file>", "Output JSON context file")
    .option("--task <text>", "User task for triggered matching")
    .option("--mode <mode>", "Context mode: all|triggered", "triggered")
    .option("--target <target>", "Context target: openai|chatgpt|claude|generic", "generic")
    .option("--no-policies", "Exclude policies")
    .option("--no-templates", "Exclude templates")
    .option("--no-workflows", "Exclude workflows")
    .option("--include-references", "Include references")
    .option("--no-prompts", "Exclude prepared prompts")
    .option("--max-skills <count>", "Maximum skills for triggered mode", parseInteger)
    .action(
      async (
        kitPath: string,
        options: {
          out: string;
          task?: string;
          mode: string;
          target: string;
          policies: boolean;
          templates: boolean;
          workflows: boolean;
          includeReferences?: boolean;
          prompts: boolean;
          maxSkills?: number;
        }
      ) => {
        if (!contextModes.includes(options.mode)) {
          throw new Error(`Invalid context mode: ${options.mode}`);
        }

        if (!contextTargets.includes(options.target)) {
          throw new Error(`Invalid context target: ${options.target}`);
        }

        const context = await buildAgentKitContext({
          kitPath,
          userTask: options.task,
          mode: options.mode as AgentKitContextBuildMode,
          target: options.target as AgentKitContextTarget,
          includePolicies: options.policies,
          includeTemplates: options.templates,
          includeWorkflows: options.workflows,
          includeReferences: options.includeReferences === true,
          includePrompts: options.prompts,
          maxSkills: options.maxSkills
        });
        const outPath = path.resolve(options.out);
        await mkdir(path.dirname(outPath), { recursive: true });
        await writeFile(outPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
        console.log(outPath);
      }
    );

  program
    .command("list-prompts")
    .argument("<kit-path>", "Agent Kit folder")
    .action(async (kitPath: string) => {
      console.log(JSON.stringify(await listPreparedPrompts(kitPath), null, 2));
    });

  program
    .command("render-prompt")
    .argument("<kit-path>", "Agent Kit folder")
    .argument("<prompt-id>", "Prepared prompt id")
    .requiredOption("--inputs <json-file>", "Input values JSON file")
    .option("--out <file>", "Output rendered prompt file")
    .action(
      async (
        kitPath: string,
        promptId: string,
        options: {
          inputs: string;
          out?: string;
        }
      ) => {
        const prompt = await findPreparedPrompt(kitPath, promptId);
        const inputValues = JSON.parse(await readFile(options.inputs, "utf8")) as Record<string, unknown>;
        const rendered = renderPreparedPrompt(prompt, inputValues);
        if (options.out) {
          const outPath = path.resolve(options.out);
          await mkdir(path.dirname(outPath), { recursive: true });
          await writeFile(outPath, rendered, "utf8");
        } else {
          console.log(rendered);
        }
      }
    );

  program
    .command("validate-prompt-inputs")
    .argument("<kit-path>", "Agent Kit folder")
    .argument("<prompt-id>", "Prepared prompt id")
    .requiredOption("--inputs <json-file>", "Input values JSON file")
    .action(async (kitPath: string, promptId: string, options: { inputs: string }) => {
      const prompt = await findPreparedPrompt(kitPath, promptId);
      const inputValues = JSON.parse(await readFile(options.inputs, "utf8")) as Record<string, unknown>;
      console.log(JSON.stringify(validatePreparedPromptInputs(prompt, inputValues), null, 2));
    });

  program
    .command("export-codex")
    .argument("<kit-path>", "Agent Kit folder")
    .requiredOption("--dest <skills-dir>", "Destination Codex skills directory")
    .option("--force", "Replace this kit's AgentKitForge-generated Codex skill folders")
    .action(
      async (
        kitPath: string,
        options: {
          dest: string;
          force?: boolean;
        }
      ) => {
        const result = await exportAgentKitToCodex(kitPath, options.dest, {
          force: options.force === true
        });
        console.log(JSON.stringify(result, null, 2));
      }
    );

  program
    .command("export-claude-code")
    .argument("<kit-path>", "Agent Kit folder")
    .requiredOption("--dest <plugins-dir>", "Destination Claude Code plugins directory")
    .option("--force", "Replace this kit's AgentKitForge-generated Claude Code plugin folder")
    .action(
      async (
        kitPath: string,
        options: {
          dest: string;
          force?: boolean;
        }
      ) => {
        const result = await exportAgentKitToClaudeCode(kitPath, options.dest, {
          force: options.force === true
        });
        console.log(JSON.stringify(result, null, 2));
      }
    );

  const version = program
    .command("version")
    .description("Read or update an Agent Kit manifest content version");

  version
    .command("get")
    .argument("<path>", "Agent Kit folder")
    .action(async (kitPath: string) => {
      console.log(formatDisplayVersion(await getAgentKitVersion(kitPath)));
    });

  version
    .command("set")
    .argument("<path>", "Agent Kit folder")
    .argument("<version>", "New version, a positive integer e.g. 2 (displayed v2)")
    .action(async (kitPath: string, nextVersion: string) => {
      const result = await setAgentKitVersion(kitPath, nextVersion);
      console.log(JSON.stringify(result, null, 2));
    });

  version
    .command("next")
    .argument("<path>", "Agent Kit folder")
    .description("Auto-increment the content version by 1")
    .action(async (kitPath: string) => {
      const result = await nextAgentKitVersion(kitPath);
      console.log(JSON.stringify(result, null, 2));
    });

  registerMarketCommands(program);
  registerGatewayCommands(program);

  return program;
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, ...value.split(",").map((item) => item.trim()).filter(Boolean)];
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }

  return parsed;
}

async function findPreparedPrompt(kitPath: string, promptId: string) {
  const prompts = await listPreparedPrompts(kitPath);
  const prompt = prompts.find((entry) => entry.id === promptId);
  if (!prompt) {
    throw new Error(`Prepared prompt not found: ${promptId}`);
  }

  return prompt;
}
