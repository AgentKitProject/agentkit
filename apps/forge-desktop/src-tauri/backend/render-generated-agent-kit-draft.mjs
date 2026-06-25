import path from "node:path";
import { pathToFileURL } from "node:url";

const [, , draftJson, outputFolder, force] = process.argv;

if (!draftJson || !outputFolder) {
  console.error("Usage: node render-generated-agent-kit-draft.mjs <draftJson> <outputFolder> <force>");
  process.exit(2);
}

try {
  const core = await loadCore();
  const draft = JSON.parse(draftJson);
  const result = await core.renderAgentKitDraft(draft, outputFolder, {
    force: force === "true",
  });
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function loadCore() {
  if (process.env.AGENTKITFORGE_ALLOW_DEV_OVERRIDES === "1" && process.env.AGENTKITFORGE_CORE_PATH) {
    const entry = path.join(process.env.AGENTKITFORGE_CORE_PATH, "dist", "index.js");
    return import(pathToFileURL(entry).href);
  }

  const siblingEntry = path.resolve(process.cwd(), "..", "agentkitforge-core", "dist", "index.js");
  try {
    return await import(pathToFileURL(siblingEntry).href);
  } catch {
    // Fall back to the installed package.
  }

  return import("@agentkitforge/core");
}
