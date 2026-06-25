import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { resolveInside, safeListFilesRecursive } from "../fs/safety.js";
import { parseSkillMarkdown } from "../validation/skill.js";
import { readAgentKit } from "../package/reader.js";
import { listPreparedPrompts } from "../prompts/prompts.js";
import type { AgentKitDraft } from "../draft/schema.js";

export interface LoadAgentKitAsDraftResult {
  draft: AgentKitDraft;
  warnings: string[];
  sourceFiles: string[];
}

export async function loadAgentKitAsDraft(kitPath: string): Promise<LoadAgentKitAsDraftResult> {
  const kit = await readAgentKit(kitPath);
  if (!kit.manifest) {
    throw new Error("Unable to load Agent Kit as draft because agentkit.yaml is invalid.");
  }

  const warnings: string[] = [];
  const sourceFiles = ["agentkit.yaml"];
  const preparedPrompts = await listPreparedPrompts(kit.rootPath);
  sourceFiles.push(...preparedPrompts.map((prompt) => `prompts/${prompt.id}.yaml`));

  const skills = [];
  for (const skill of kit.manifest.skills) {
    const skillPath = resolveInside(kit.rootPath, skill.path);
    const parsed = parseSkillMarkdown(await readFile(skillPath, "utf8"), skillPath);
    sourceFiles.push(skill.path);
    skills.push({
      id: skill.id,
      name: String(parsed.frontmatter.name ?? skill.id),
      description: skill.description,
      triggers: skill.triggers,
      riskLevel: String(parsed.frontmatter.riskLevel ?? kit.manifest.risk.level),
      useWhen: extractSection(parsed.body, "Use when") ?? "Use when this skill is relevant.",
      procedure: extractSection(parsed.body, "Procedure") ?? "Follow the skill instructions.",
      output: extractSection(parsed.body, "Output") ?? "Return Markdown."
    });
  }

  const policies = await loadPolicies(kit.rootPath, sourceFiles, warnings);
  const templates = await loadTemplates(kit.rootPath, sourceFiles);
  const examples = await loadExamples(kit.rootPath, sourceFiles);
  const workflowFiles = await listDirectoryFiles(path.join(kit.rootPath, "workflows"));
  const referenceFiles = await listDirectoryFiles(path.join(kit.rootPath, "references"));
  if (workflowFiles.length > 0) {
    warnings.push("Workflows are not fully represented in AgentKitDraft yet.");
    sourceFiles.push(...workflowFiles.map((file) => normalizePath(path.relative(kit.rootPath, file))));
  }
  if (referenceFiles.length > 0) {
    warnings.push("References are not fully represented in AgentKitDraft yet.");
    sourceFiles.push(...referenceFiles.map((file) => normalizePath(path.relative(kit.rootPath, file))));
  }

  return {
    draft: {
      schemaVersion: kit.manifest.schemaVersion,
      id: kit.manifest.id,
      name: kit.manifest.name,
      version: kit.manifest.version,
      description: kit.manifest.description,
      author: kit.manifest.author,
      license: kit.manifest.license,
      setupLevel: kit.manifest.userExperience.setupLevel,
      compatibilityTargets: kit.manifest.compatibility.targets,
      riskLevel: kit.manifest.risk.level,
      skills,
      policies,
      examples,
      templates,
      preparedPrompts
    },
    warnings,
    sourceFiles: [...new Set(sourceFiles)].sort()
  };
}

async function loadPolicies(rootPath: string, sourceFiles: string[], warnings: string[]) {
  const files = await listDirectoryFiles(path.join(rootPath, "policies"));
  return Promise.all(
    files
      .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
      .map(async (file) => {
        sourceFiles.push(normalizePath(path.relative(rootPath, file)));
        const parsed = YAML.parse(await readFile(file, "utf8")) as { id?: string; description?: string; rules?: string[] };
        return {
          id: parsed.id ?? path.basename(file, path.extname(file)),
          description: parsed.description,
          rules: parsed.rules && parsed.rules.length > 0 ? parsed.rules : ["Review this policy before use."]
        };
      })
  ).catch(() => {
    warnings.push("Some policies could not be converted to draft policy objects.");
    return [];
  });
}

async function loadTemplates(rootPath: string, sourceFiles: string[]) {
  const files = await listDirectoryFiles(path.join(rootPath, "templates"));
  return Promise.all(
    files.map(async (file) => {
      const relativePath = normalizePath(path.relative(path.join(rootPath, "templates"), file));
      sourceFiles.push(normalizePath(path.relative(rootPath, file)));
      return {
        id: path.basename(file, path.extname(file)),
        path: relativePath,
        content: await readFile(file, "utf8")
      };
    })
  );
}

async function loadExamples(rootPath: string, sourceFiles: string[]) {
  const promptFiles = await listDirectoryFiles(path.join(rootPath, "examples", "prompts"));
  const outputFiles = await listDirectoryFiles(path.join(rootPath, "examples", "outputs"));
  const outputs = new Map(outputFiles.map((file) => [path.basename(file, path.extname(file)), file]));
  return Promise.all(
    promptFiles.map(async (file) => {
      const id = path.basename(file, path.extname(file));
      sourceFiles.push(normalizePath(path.relative(rootPath, file)));
      const outputFile = outputs.get(id);
      if (outputFile) {
        sourceFiles.push(normalizePath(path.relative(rootPath, outputFile)));
      }
      return {
        id,
        prompt: await readFile(file, "utf8"),
        output: outputFile ? await readFile(outputFile, "utf8") : undefined
      };
    })
  );
}

function extractSection(body: string, heading: string): string | undefined {
  const match = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |\\s*$)`, "m").exec(body);
  return match?.[1]?.trim();
}

async function listDirectoryFiles(directoryPath: string): Promise<string[]> {
  if (!(await exists(directoryPath))) {
    return [];
  }
  return (await safeListFilesRecursive(directoryPath)).map((file) => file.absolutePath).sort();
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
