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
