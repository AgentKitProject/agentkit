import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { validateAgentKit } from "../validation/validator.js";
import type { ValidationReport } from "../types.js";

export interface AgentKitCandidateInspection {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  looksLikeAgentKit: boolean;
  missingRequiredFiles: string[];
  missingRequiredFolders: string[];
  foundFiles: string[];
  foundSkills: string[];
  recommendedFixes: string[];
  validationReport?: ValidationReport;
  friendlySummary: string;
}

export async function inspectAgentKitCandidate(inputPath: string): Promise<AgentKitCandidateInspection> {
  const rootPath = path.resolve(inputPath);
  if (!(await exists(rootPath))) {
    return {
      path: rootPath,
      exists: false,
      isDirectory: false,
      looksLikeAgentKit: false,
      missingRequiredFiles: ["agentkit.yaml", "AGENTKIT.md", "START_HERE.md", "skills/<skill-id>/SKILL.md"],
      missingRequiredFolders: ["skills"],
      foundFiles: [],
      foundSkills: [],
      recommendedFixes: ["Select an existing Agent Kit folder."],
      friendlySummary: `This folder does not exist: ${rootPath}`
    };
  }

  const stats = await stat(rootPath);
  if (!stats.isDirectory()) {
    return {
      path: rootPath,
      exists: true,
      isDirectory: false,
      looksLikeAgentKit: false,
      missingRequiredFiles: ["agentkit.yaml", "AGENTKIT.md", "START_HERE.md", "skills/<skill-id>/SKILL.md"],
      missingRequiredFolders: ["skills"],
      foundFiles: [],
      foundSkills: [],
      recommendedFixes: ["Select a folder that contains the Agent Kit files."],
      friendlySummary: "This path exists but is not a directory."
    };
  }

  const foundFiles = await findRootFiles(rootPath);
  const foundSkills = await findSkills(rootPath);
  const missingRequiredFiles = ["agentkit.yaml", "AGENTKIT.md", "START_HERE.md"].filter(
    (file) => !foundFiles.includes(file)
  );
  const missingRequiredFolders = (await exists(path.join(rootPath, "skills"))) ? [] : ["skills"];
  if (foundSkills.length === 0) {
    missingRequiredFiles.push("skills/<skill-id>/SKILL.md");
  }

  const looksLikeAgentKit = missingRequiredFiles.length === 0 && missingRequiredFolders.length === 0;
  const validationReport = looksLikeAgentKit ? await validateAgentKit(rootPath, "local-valid") : undefined;
  const missing = [...missingRequiredFiles, ...missingRequiredFolders];

  return {
    path: rootPath,
    exists: true,
    isDirectory: true,
    looksLikeAgentKit,
    missingRequiredFiles,
    missingRequiredFolders,
    foundFiles,
    foundSkills,
    recommendedFixes: looksLikeAgentKit
      ? []
      : ["Place the Agent Kit files at the repository root or select a subfolder that contains the kit."],
    validationReport,
    friendlySummary: looksLikeAgentKit
      ? "This folder looks like an Agent Kit."
      : `This repository does not look like an Agent Kit. It is missing ${joinFriendly(missing)}. Place the Agent Kit files at the repository root or select a subfolder that contains the kit.`
  };
}

async function findRootFiles(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
}

async function findSkills(rootPath: string): Promise<string[]> {
  const skillsPath = path.join(rootPath, "skills");
  if (!(await exists(skillsPath))) {
    return [];
  }

  const entries = await readdir(skillsPath, { withFileTypes: true });
  const skills: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && (await exists(path.join(skillsPath, entry.name, "SKILL.md")))) {
      skills.push(entry.name);
    }
  }

  return skills.sort();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function joinFriendly(values: string[]): string {
  if (values.length <= 1) {
    return values[0] ?? "required Agent Kit files";
  }

  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}
