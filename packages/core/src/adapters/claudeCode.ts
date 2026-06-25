import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentKitManifest, AgentKitSkillManifest } from "../types.js";
import { readAgentKit } from "../package/reader.js";
import {
  assertSafeDestinationDirectory,
  assertSafeId,
  resolveInside,
  safeCopyDirectory
} from "../fs/safety.js";

export interface ClaudeCodeExportOptions {
  force?: boolean;
}

export interface ClaudeCodeExportResult {
  destinationDir: string;
  pluginFolder: string;
  exportedSkillFolders: string[];
  pluginManifestPath: string;
  warnings: string[];
}

const MARKER_FILE = ".agentkitforge-export.json";
const SUPPORTING_DIRECTORIES = ["policies", "templates", "workflows", "references"] as const;

export async function exportAgentKitToClaudeCode(
  kitPath: string,
  destinationDir: string,
  options: ClaudeCodeExportOptions = {}
): Promise<ClaudeCodeExportResult> {
  const kit = await readAgentKit(kitPath);
  if (!kit.manifest) {
    throw new Error("Unable to export to Claude Code because agentkit.yaml is invalid.");
  }

  const resolvedDestination = path.resolve(destinationDir);
  assertSafeId(kit.manifest.id, "kit id");
  for (const skill of kit.manifest.skills) {
    assertSafeId(skill.id, "skill id");
  }
  await assertSafeDestinationDirectory(resolvedDestination);
  await mkdir(resolvedDestination, { recursive: true });

  const pluginFolder = resolveInside(resolvedDestination, pluginFolderName(kit.manifest));
  await preparePluginFolder(pluginFolder, options.force === true);
  await mkdir(pluginFolder, { recursive: true });

  await writePluginManifest(pluginFolder, kit.manifest);
  await writeMarker(pluginFolder, kit.manifest);
  await copyIfPresent(resolveInside(kit.rootPath, "AGENTKIT.md"), resolveInside(pluginFolder, "AGENTKIT.md"));
  await copyIfPresent(resolveInside(kit.rootPath, "README.md"), resolveInside(pluginFolder, "README.md"));

  const exportedSkillFolders: string[] = [];
  for (const skill of [...kit.manifest.skills].sort((left, right) => left.id.localeCompare(right.id))) {
    const sourceSkillDir = path.dirname(resolveInside(kit.rootPath, skill.path));
    const destinationSkillDir = resolveInside(pluginFolder, `skills/${skill.id}`);
    await mkdir(path.dirname(destinationSkillDir), { recursive: true });
    await safeCopyDirectory(sourceSkillDir, destinationSkillDir);
    exportedSkillFolders.push(destinationSkillDir);
  }

  for (const directory of SUPPORTING_DIRECTORIES) {
    await copyDirectoryIfPresent(resolveInside(kit.rootPath, directory), resolveInside(pluginFolder, directory));
  }

  return {
    destinationDir: resolvedDestination,
    pluginFolder,
    exportedSkillFolders,
    pluginManifestPath: resolveInside(pluginFolder, ".claude-plugin/plugin.json"),
    warnings: [
      "Claude Code plugin schema support is an initial AgentKitForge adapter; verify loading behavior with your Claude Code version."
    ]
  };
}

async function preparePluginFolder(pluginFolder: string, force: boolean): Promise<void> {
  if (!(await exists(pluginFolder))) {
    return;
  }

  if (!force) {
    throw new Error(
      `Refusing to overwrite existing Claude Code plugin folder: ${pluginFolder}. Use --force to replace the AgentKitForge-generated plugin folder.`
    );
  }

  await assertAgentKitForgeGeneratedPlugin(pluginFolder);
  await rm(pluginFolder, { recursive: true, force: true });
}

async function assertAgentKitForgeGeneratedPlugin(pluginFolder: string): Promise<void> {
  const markerPath = resolveInside(pluginFolder, MARKER_FILE);
  if (!(await exists(markerPath))) {
    throw new Error(`Refusing to remove non-AgentKitForge plugin folder: ${pluginFolder}`);
  }

  const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
    generatedBy?: string;
    target?: string;
  };
  if (marker.generatedBy !== "agentkitforge" || marker.target !== "claude-code") {
    throw new Error(`Refusing to remove plugin folder without Claude Code AgentKitForge marker: ${pluginFolder}`);
  }
}

async function writePluginManifest(pluginFolder: string, manifest: AgentKitManifest): Promise<void> {
  const pluginManifestPath = resolveInside(pluginFolder, ".claude-plugin/plugin.json");
  await mkdir(path.dirname(pluginManifestPath), { recursive: true });
  await writeFile(
    pluginManifestPath,
    `${JSON.stringify(
      {
        generatedBy: "agentkitforge",
        target: "claude-code",
        schemaVersion: "0.1",
        name: manifest.name,
        id: manifest.id,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author?.name,
        skills: manifest.skills.map((skill) => ({
          id: skill.id,
          path: `skills/${skill.id}/SKILL.md`,
          description: skill.description,
          triggers: skill.triggers
        }))
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function writeMarker(pluginFolder: string, manifest: AgentKitManifest): Promise<void> {
  await writeFile(
    resolveInside(pluginFolder, MARKER_FILE),
    `${JSON.stringify(
      {
        generatedBy: "agentkitforge",
        target: "claude-code",
        kitId: manifest.id
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function copyIfPresent(source: string, destination: string): Promise<void> {
  if (!(await exists(source))) {
    return;
  }

  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function copyDirectoryIfPresent(source: string, destination: string): Promise<void> {
  if (!(await exists(source))) {
    return;
  }

  await safeCopyDirectory(source, destination);
}

function pluginFolderName(manifest: AgentKitManifest): string {
  return `${manifest.id}-claude-code-plugin`;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
