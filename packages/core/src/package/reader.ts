import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { agentKitManifestSchema } from "../schema/agentkit.js";
import type { AgentKitManifest, LoadedAgentKit } from "../types.js";

export async function readAgentKit(rootPath: string): Promise<LoadedAgentKit> {
  const resolvedRoot = path.resolve(rootPath);
  const manifestPath = path.join(resolvedRoot, "agentkit.yaml");
  const rawText = await readFile(manifestPath, "utf8");
  const manifestRaw = YAML.parse(rawText) as unknown;
  const parsed = agentKitManifestSchema.safeParse(manifestRaw);

  return {
    rootPath: resolvedRoot,
    manifestPath,
    manifestRaw,
    manifest: parsed.success ? (parsed.data as AgentKitManifest) : undefined
  };
}

export async function readYamlFile(filePath: string): Promise<unknown> {
  return YAML.parse(await readFile(filePath, "utf8")) as unknown;
}
