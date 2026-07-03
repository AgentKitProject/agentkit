import JSZip from "jszip";
import YAML from "yaml";
import { agentKitAutomationsSchema } from "../schema/agentkit.js";
import type { AgentKitAutomation, AgentKitManifest } from "../types.js";

/**
 * Typed accessor for the optional `automations:` manifest block.
 *
 * Returns the kit's suggested automations, or an empty array when the block
 * is absent. The entries are re-validated through the strict automations
 * schema, so callers holding a loosely-typed manifest (e.g. one parsed before
 * this field existed, or raw YAML routed through `[key: string]: unknown`)
 * still only ever receive well-formed, unknown-key-free entries.
 */
export function getKitAutomations(
  manifest: Pick<AgentKitManifest, "automations"> | Record<string, unknown>
): AgentKitAutomation[] {
  const candidate = (manifest as Record<string, unknown>).automations;
  if (candidate === undefined || candidate === null) {
    return [];
  }

  const parsed = agentKitAutomationsSchema.safeParse(candidate);
  return parsed.success ? (parsed.data as AgentKitAutomation[]) : [];
}

/**
 * Extracts the suggested automations from a packaged `.agentkit.zip` without
 * touching the filesystem: reads the root `agentkit.yaml` entry, parses it,
 * and routes it through `getKitAutomations` (so entries are re-validated
 * through the strict automations schema — unknown keys never pass through).
 *
 * Defensive by design for server-side use (the Market validation worker):
 * a missing manifest, malformed zip, malformed YAML, or malformed automations
 * block all yield `[]`, never a throw.
 */
export async function getKitAutomationsFromZip(bytes: Uint8Array): Promise<AgentKitAutomation[]> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const manifestEntry = zip.file("agentkit.yaml");
    if (!manifestEntry) {
      return [];
    }

    const manifestRaw = YAML.parse(await manifestEntry.async("text")) as unknown;
    if (typeof manifestRaw !== "object" || manifestRaw === null || Array.isArray(manifestRaw)) {
      return [];
    }

    return getKitAutomations(manifestRaw as Record<string, unknown>);
  } catch {
    return [];
  }
}
