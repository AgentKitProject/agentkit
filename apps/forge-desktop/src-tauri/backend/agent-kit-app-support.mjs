import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_TEXT_EXAMPLE_BYTES = 2 * 1024 * 1024;
const MAX_SPREADSHEET_EXAMPLE_BYTES = 10 * 1024 * 1024;

const [, , action, input] = process.argv;

if (!action || !input) {
  console.error("Usage: node agent-kit-app-support.mjs <inspect|summary|load-draft|example-documents> <input>");
  process.exit(2);
}

try {
  const core = await loadCore();

  if (action === "inspect") {
    const inspection = await core.inspectAgentKitCandidate(input);
    process.stdout.write(JSON.stringify(inspection));
    process.exit(0);
  }

  if (action === "summary") {
    const summary = await core.getAgentKitSummary(input);
    process.stdout.write(JSON.stringify(summary));
    process.exit(0);
  }

  if (action === "load-draft") {
    const result = await core.loadAgentKitAsDraft(input);
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  }

  if (action === "example-documents") {
    const filePaths = JSON.parse(input);
    const documents = await Promise.all(filePaths.map((filePath, index) => loadExampleDocument(core, filePath, index)));
    process.stdout.write(JSON.stringify(documents));
    process.exit(0);
  }

  throw new Error(`Unsupported app support action: ${action}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function loadExampleDocument(core, filePath, index) {
  const filename = path.basename(filePath);
  const kind = core.inferExampleInputDocumentKind(filename);
  if (!kind) {
    throw new Error(`Unsupported example input document: ${filename}`);
  }

  const stat = await fs.stat(filePath);
  const maxBytes = kind === "spreadsheet" ? MAX_SPREADSHEET_EXAMPLE_BYTES : MAX_TEXT_EXAMPLE_BYTES;
  if (stat.size > maxBytes) {
    throw new Error(`Example input document is too large to preview safely: ${filename}. Limit is ${formatBytes(maxBytes)}.`);
  }

  const document = {
    id: `example-input-${index + 1}`,
    name: filename.replace(/\.[^.]+$/, ""),
    filename,
    kind,
    notes: `${filename} (${formatBytes(stat.size)})`,
  };

  if (kind === "text" || kind === "markdown" || kind === "csv") {
    const content = await fs.readFile(filePath, "utf8");
    document.extractedText = content.length > 12000 ? `${content.slice(0, 12000)}\n\n[Preview truncated]` : content;
  } else if (kind === "spreadsheet") {
    document.notes = `${document.notes}. Spreadsheet parsing is not enabled in the desktop app yet; use the file name and metadata as source notes.`;
  }

  return document;
}

function formatBytes(value) {
  if (value < 1024) return `${value} bytes`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
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
