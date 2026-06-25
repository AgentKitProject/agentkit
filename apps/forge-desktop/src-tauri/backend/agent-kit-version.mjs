import path from "node:path";
import { pathToFileURL } from "node:url";

const [, , subcommand, rootPath, value] = process.argv;

if (!subcommand || !rootPath) {
  console.error("Usage: node agent-kit-version.mjs <get|set|next> <rootPath> [value]");
  process.exit(2);
}

try {
  const core = await loadCore();

  if (subcommand === "get") {
    const version = await core.getAgentKitVersion(rootPath);
    process.stdout.write(JSON.stringify({ version }));
  } else if (subcommand === "set") {
    if (!value) {
      console.error("Usage: node agent-kit-version.mjs set <rootPath> <version>");
      process.exit(2);
    }
    const result = await core.setAgentKitVersion(rootPath, value);
    process.stdout.write(JSON.stringify(result));
  } else if (subcommand === "next") {
    const result = await core.nextAgentKitVersion(rootPath);
    process.stdout.write(JSON.stringify(result));
  } else {
    console.error(`Unknown subcommand: ${subcommand}`);
    process.exit(2);
  }
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
