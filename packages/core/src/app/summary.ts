import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readAgentKit } from "../package/reader.js";
import { listPreparedPrompts } from "../prompts/prompts.js";
import { validateAgentKit } from "../validation/validator.js";
import { getKitAutomations } from "./automations.js";

export interface AgentKitSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  domain?: string;
  targetUsers?: string[];
  validationStatus: "valid" | "invalid";
  counts: Record<string, number>;
  lists: Record<string, unknown[]>;
  paths: {
    rootPath: string;
    manifestPath: string;
  };
  warnings: string[];
}

export async function getAgentKitSummary(kitPath: string): Promise<AgentKitSummary> {
  const kit = await readAgentKit(kitPath);
  if (!kit.manifest) {
    throw new Error("Unable to summarize Agent Kit because agentkit.yaml is invalid.");
  }

  const prompts = await listPreparedPrompts(kit.rootPath);
  const automations = getKitAutomations(kit.manifest);
  const validation = await validateAgentKit(kit.rootPath, "local-valid");
  const directories = ["policies", "templates", "examples", "workflows", "references", "evals", "scripts"];
  const counts: Record<string, number> = {
    skills: kit.manifest.skills.length,
    preparedPrompts: prompts.length,
    automations: automations.length
  };
  const lists: Record<string, unknown[]> = {
    skills: kit.manifest.skills.map((skill) => ({
      id: skill.id,
      name: skill.id,
      description: skill.description
    })),
    preparedPrompts: prompts.map((prompt) => ({
      id: prompt.id,
      name: prompt.name,
      description: prompt.description,
      inputCount: prompt.inputs.length,
      documentLikeOutput: prompt.documentLikeOutput === true
    })),
    automations: automations.map((automation) => ({
      name: automation.name,
      description: automation.description,
      trigger: automation.trigger,
      promptTemplate: automation.promptTemplate
    }))
  };

  for (const directory of directories) {
    const files = await listDirectoryFiles(path.join(kit.rootPath, directory));
    counts[directory] = files.length;
    lists[directory] = files.map((file) => ({
      id: path.basename(file, path.extname(file)),
      name: path.basename(file),
      path: normalizePath(path.relative(kit.rootPath, file))
    }));
  }

  return {
    id: kit.manifest.id,
    name: kit.manifest.name,
    version: String(kit.manifest.version),
    description: kit.manifest.description,
    domain: typeof kit.manifest.domain === "string" ? kit.manifest.domain : undefined,
    targetUsers: Array.isArray(kit.manifest.targetUsers)
      ? kit.manifest.targetUsers.filter((value): value is string => typeof value === "string")
      : undefined,
    validationStatus: validation.valid ? "valid" : "invalid",
    counts,
    lists,
    paths: {
      rootPath: kit.rootPath,
      manifestPath: kit.manifestPath
    },
    warnings: validation.issues.map((issue) => issue.message)
  };
}

async function listDirectoryFiles(directoryPath: string): Promise<string[]> {
  if (!(await exists(directoryPath))) {
    return [];
  }

  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listDirectoryFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizePath(input: string): string {
  return input.replaceAll("\\", "/");
}
