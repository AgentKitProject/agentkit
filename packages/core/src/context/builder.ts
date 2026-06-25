import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { resolveInside, safeListFilesRecursive } from "../fs/safety.js";
import { readAgentKit } from "../package/reader.js";
import type { AgentKitSkillManifest } from "../types.js";
import type { AgentKitContextRequest, AgentKitContextResult } from "./types.js";

interface ContextFile {
  relativePath: string;
  content: string;
}

interface ScoredSkill {
  skill: AgentKitSkillManifest;
  score: number;
}

const OPTIONAL_DIRECTORIES: Array<{
  key: keyof Pick<
    AgentKitContextRequest,
    "includePolicies" | "includeTemplates" | "includeWorkflows" | "includeReferences"
    | "includePrompts"
  >;
  directory: string;
}> = [
  { key: "includePolicies", directory: "policies" },
  { key: "includeTemplates", directory: "templates" },
  { key: "includeWorkflows", directory: "workflows" },
  { key: "includeReferences", directory: "references" },
  { key: "includePrompts", directory: "prompts" }
];

export async function buildAgentKitContext(
  request: AgentKitContextRequest
): Promise<AgentKitContextResult> {
  const kit = await readAgentKit(request.kitPath);
  if (!kit.manifest) {
    throw new Error("Unable to build context because agentkit.yaml is invalid.");
  }

  const warnings: string[] = [];
  const includedFiles: ContextFile[] = [];
  const includedSkills = selectSkills(kit.manifest.skills, request, warnings);

  includedFiles.push(await readContextFile(kit.rootPath, "AGENTKIT.md"));
  for (const skill of includedSkills) {
    includedFiles.push(await readContextFile(kit.rootPath, skill.path));
  }

  for (const optionalDirectory of OPTIONAL_DIRECTORIES) {
    if (request[optionalDirectory.key] === true) {
      try {
        includedFiles.push(...(await readDirectoryFiles(kit.rootPath, optionalDirectory.directory, request)));
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : `Skipped ${optionalDirectory.directory}`);
      }
    }
  }

  const dedupedFiles = dedupeFiles(includedFiles);

  return {
    systemContext: renderSystemContext(request, dedupedFiles),
    userContext: renderUserContext(request),
    includedFiles: dedupedFiles.map((file) => file.relativePath),
    includedSkills: includedSkills.map((skill) => skill.id),
    warnings
  };
}

function selectSkills(
  skills: AgentKitSkillManifest[],
  request: AgentKitContextRequest,
  warnings: string[]
): AgentKitSkillManifest[] {
  const sortedSkills = [...skills].sort((left, right) => left.id.localeCompare(right.id));
  if (request.mode === "all") {
    return applyMaxSkills(sortedSkills, request.maxSkills);
  }

  const task = request.userTask?.trim() ?? "";
  const matches = sortedSkills
    .map((skill) => ({ skill, score: scoreSkill(skill, task) }))
    .filter((match) => match.score > 0)
    .sort(compareScoredSkills);

  if (matches.length === 0) {
    warnings.push("No specific skill matched the task; included all skills.");
    return applyMaxSkills(sortedSkills, request.maxSkills);
  }

  return applyMaxSkills(
    matches.map((match) => match.skill),
    request.maxSkills
  );
}

function scoreSkill(skill: AgentKitSkillManifest, task: string): number {
  if (!task) {
    return 0;
  }

  const taskLower = task.toLowerCase();
  const taskTokens = tokenize(taskLower);
  let score = 0;

  for (const trigger of skill.triggers) {
    const triggerLower = trigger.toLowerCase();
    if (taskLower.includes(triggerLower)) {
      score += 10;
      continue;
    }

    const triggerTokens = tokenize(triggerLower);
    if (triggerTokens.size > 0 && [...triggerTokens].every((token) => taskTokens.has(token))) {
      score += 5;
    }
  }

  const descriptionMatches = [...tokenize(skill.description.toLowerCase())].filter((token) =>
    taskTokens.has(token)
  ).length;
  if (descriptionMatches >= 2) {
    score += descriptionMatches;
  }

  return score;
}

function compareScoredSkills(left: ScoredSkill, right: ScoredSkill): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }

  return left.skill.id.localeCompare(right.skill.id);
}

function applyMaxSkills(
  skills: AgentKitSkillManifest[],
  maxSkills: number | undefined
): AgentKitSkillManifest[] {
  if (maxSkills === undefined || maxSkills < 1) {
    return skills;
  }

  return skills.slice(0, maxSkills);
}

async function readContextFile(rootPath: string, relativePath: string): Promise<ContextFile> {
  const resolvedPath = resolveInside(rootPath, relativePath);
  return {
    relativePath: normalizePath(relativePath),
    content: await readFile(resolvedPath, "utf8")
  };
}

async function readDirectoryFiles(
  rootPath: string,
  relativeDirectory: string,
  request: AgentKitContextRequest
): Promise<ContextFile[]> {
  const directoryPath = resolveInside(rootPath, relativeDirectory);
  if (!(await existsDirectory(directoryPath))) {
    return [];
  }

  const files = await safeListFilesRecursive(directoryPath, {
    maxFiles: request.maxFiles,
    maxBytes: request.maxBytes
  });
  return Promise.all(
    files.map((file) => readContextFile(rootPath, path.relative(rootPath, file.absolutePath)))
  );
}

function dedupeFiles(files: ContextFile[]): ContextFile[] {
  const seen = new Set<string>();
  const deduped: ContextFile[] = [];

  for (const file of files) {
    if (seen.has(file.relativePath)) {
      continue;
    }

    seen.add(file.relativePath);
    deduped.push(file);
  }

  return deduped;
}

function renderSystemContext(request: AgentKitContextRequest, files: ContextFile[]): string {
  const header = [
    "AgentKitForge Context",
    `Target: ${request.target}`,
    `Mode: ${request.mode}`,
    "Use the included Agent Kit instructions and skills as authoritative context."
  ].join("\n");

  const fileSections = files.map(
    (file) => `\n\n--- FILE: ${file.relativePath} ---\n${file.content.trim()}`
  );

  return `${header}${fileSections.join("")}\n`;
}

function renderUserContext(request: AgentKitContextRequest): string {
  if (!request.userTask) {
    return "No user task was provided.\n";
  }

  return `User task:\n${request.userTask}\n`;
}

async function existsDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

function normalizePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function tokenize(input: string): Set<string> {
  return new Set(
    input
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
  );
}
