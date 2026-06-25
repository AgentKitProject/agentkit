import path from "node:path";
import { pathToFileURL } from "node:url";

const [, , action, kitPath, promptId, inputJson] = process.argv;

if (!action || !kitPath) {
  console.error("Usage: node prepared-prompts.mjs <list|render|validate> <kitPath> [promptId] [inputJson]");
  process.exit(2);
}

try {
  const core = await loadCore();
  const prompts = await core.listPreparedPrompts(kitPath);

  if (action === "list") {
    process.stdout.write(JSON.stringify(prompts));
    process.exit(0);
  }

  const prompt = prompts.find((entry) => entry.id === promptId);
  if (!prompt) {
    throw new Error(`Prepared prompt not found: ${promptId}`);
  }

  const inputValues = inputJson ? JSON.parse(inputJson) : {};
  const validationReport = core.validatePreparedPromptInputs(prompt, inputValues);
  const result = { prompt, validationReport, renderedPrompt: null };

  if (action === "render") {
    result.renderedPrompt = validationReport.valid
      ? core.renderPreparedPrompt(prompt, inputValues)
      : null;
  }

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
