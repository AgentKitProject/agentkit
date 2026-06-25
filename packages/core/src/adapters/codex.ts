import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentKitManifest, AgentKitSkillManifest } from "../types.js";
import { readAgentKit } from "../package/reader.js";
import {
  assertSafeDestinationDirectory,
  assertSafeId,
  resolveInside,
  safeCopyDirectory
} from "../fs/safety.js";

export type AgentKitTarget = "codex" | "claude-code";

export interface CodexExportOptions {
  force?: boolean;
  createIndexSkill?: boolean;
}

export interface CodexExportResult {
  destinationSkillsDir: string;
  exportedSkillFolders: string[];
  generatedIndexFolder?: string;
  warnings: string[];
}

const MARKER_FILE = ".agentkitforge-export.json";

export async function exportAgentKitToCodex(
  kitPath: string,
  destinationSkillsDir: string,
  options: CodexExportOptions = {}
): Promise<CodexExportResult> {
  const kit = await readAgentKit(kitPath);
  if (!kit.manifest) {
    throw new Error("Unable to export to Codex because agentkit.yaml is invalid.");
  }

  const destinationRoot = path.resolve(destinationSkillsDir);
  assertSafeId(kit.manifest.id, "kit id");
  for (const skill of kit.manifest.skills) {
    assertSafeId(skill.id, "skill id");
  }
  await assertSafeDestinationDirectory(destinationRoot);
  await mkdir(destinationRoot, { recursive: true });

  const createIndexSkill = options.createIndexSkill !== false;
  const plannedFolders = [
    ...kit.manifest.skills.map((skill) => folderNameForSkill(kit.manifest as AgentKitManifest, skill)),
    ...(createIndexSkill ? [folderNameForIndex(kit.manifest)] : [])
  ];

  await prepareDestinationFolders(destinationRoot, plannedFolders, options.force === true);

  const exportedSkillFolders: string[] = [];
  for (const skill of [...kit.manifest.skills].sort((left, right) => left.id.localeCompare(right.id))) {
    const folderName = folderNameForSkill(kit.manifest, skill);
    const destinationFolder = resolveInside(destinationRoot, folderName);
    await mkdir(destinationFolder, { recursive: true });
    await exportSkillFolder(kit.rootPath, kit.manifest, skill, destinationFolder);
    exportedSkillFolders.push(destinationFolder);
  }

  let generatedIndexFolder: string | undefined;
  if (createIndexSkill) {
    const folderName = folderNameForIndex(kit.manifest);
    const destinationFolder = resolveInside(destinationRoot, folderName);
    await mkdir(destinationFolder, { recursive: true });
    await writeFile(resolveInside(destinationFolder, "SKILL.md"), renderIndexSkill(kit.manifest), "utf8");
    await writeMarker(destinationFolder, kit.manifest, "index");
    generatedIndexFolder = destinationFolder;
  }

  return {
    destinationSkillsDir: destinationRoot,
    exportedSkillFolders,
    generatedIndexFolder,
    warnings: []
  };
}

async function exportSkillFolder(
  kitRoot: string,
  manifest: AgentKitManifest,
  skill: AgentKitSkillManifest,
  destinationFolder: string
): Promise<void> {
  const sourceSkillFile = resolveInside(kitRoot, skill.path);
  const sourceSkillDir = path.dirname(sourceSkillFile);
  await safeCopyDirectory(sourceSkillDir, destinationFolder);

  await writeFile(resolveInside(destinationFolder, "AGENTKIT.md"), renderSkillAgentKitReadme(manifest, skill), "utf8");
  await writeMarker(destinationFolder, manifest, skill.id);
}

async function prepareDestinationFolders(
  destinationRoot: string,
  plannedFolders: string[],
  force: boolean
): Promise<void> {
  const existingFolders = [];
  for (const folderName of plannedFolders) {
    const folderPath = resolveInside(destinationRoot, folderName);
    if (await exists(folderPath)) {
      existingFolders.push(folderPath);
    }
  }

  if (existingFolders.length > 0 && !force) {
    throw new Error(
      `Refusing to overwrite existing Codex skill export folders: ${existingFolders.join(", ")}. Use --force to replace AgentKitForge-generated folders.`
    );
  }

  for (const folderPath of existingFolders) {
    await assertAgentKitForgeGeneratedFolder(folderPath);
    await rm(folderPath, { recursive: true, force: true });
  }
}

async function assertAgentKitForgeGeneratedFolder(folderPath: string): Promise<void> {
  const markerPath = resolveInside(folderPath, MARKER_FILE);
  if (!(await exists(markerPath))) {
    throw new Error(`Refusing to remove non-AgentKitForge folder: ${folderPath}`);
  }

  const marker = JSON.parse(await readFile(markerPath, "utf8")) as { generatedBy?: string };
  if (marker.generatedBy !== "agentkitforge") {
    throw new Error(`Refusing to remove folder without AgentKitForge marker: ${folderPath}`);
  }
}

async function writeMarker(
  destinationFolder: string,
  manifest: AgentKitManifest,
  skillId: string
): Promise<void> {
  await writeFile(
    resolveInside(destinationFolder, MARKER_FILE),
    `${JSON.stringify(
      {
        generatedBy: "agentkitforge",
        target: "codex",
        kitId: manifest.id,
        skillId
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function renderSkillAgentKitReadme(manifest: AgentKitManifest, skill: AgentKitSkillManifest): string {
  return `# ${manifest.name}: ${skill.id}

This Codex skill was exported from Agent Kit \`${manifest.id}\`.

${skill.description}
`;
}

function renderIndexSkill(manifest: AgentKitManifest): string {
  return `---
id: ${manifest.id}-index
name: ${manifest.name} Index
description: Overview of the ${manifest.name} Agent Kit and its exported Codex skills.
triggers:
  - ${manifest.name}
  - ${manifest.id}
riskLevel: ${manifest.risk.level}
---

# ${manifest.name} Index

## Use when

Use this skill when a user asks what the ${manifest.name} Agent Kit contains or which exported skill to use.

## Procedure

Review the Agent Kit description and choose the most relevant exported skill.

Included skills:
${manifest.skills.map((skill) => `- ${skill.id}: ${skill.description}`).join("\n")}

## Output

Return the recommended skill and a short reason.
`;
}

function folderNameForSkill(manifest: AgentKitManifest, skill: AgentKitSkillManifest): string {
  return `${manifest.id}-${skill.id}`;
}

function folderNameForIndex(manifest: AgentKitManifest): string {
  return `${manifest.id}-index`;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
