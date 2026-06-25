import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendDistDir = path.join(root, "src-tauri", "backend-dist");
const sidecarDir = path.join(root, "src-tauri", "binaries");
const expectedBridgeFiles = [
  "validate-agent-kit.mjs",
  "security-utils.mjs",
  "create-agent-kit.mjs",
  "export-agent-kit-onefile.mjs",
  "render-agent-kit-draft.mjs",
  "generate-agent-kit-draft.mjs",
  "render-generated-agent-kit-draft.mjs",
  "package-agent-kit.mjs",
  "agent-kit-version.mjs",
  "build-agent-kit-context.mjs",
  "prepared-prompts.mjs",
  "agent-kit-app-support.mjs",
  "export-agent-kit-codex.mjs",
  "export-agent-kit-claude-code.mjs",
  "market-operation.mjs",
];

for (const file of expectedBridgeFiles) {
  await assertExists(path.join(backendDistDir, file), `Missing bundled backend bridge: ${file}`);
}

// Every backend bridge must also be listed in tauri.conf.json `resources`, or
// it builds in dev but is dropped from the packaged .app (which fails at
// runtime with "Bundled backend runtime files were not found").
const tauriConf = JSON.parse(
  await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);
const bundledResources = new Set(tauriConf?.bundle?.resources ?? []);
for (const file of expectedBridgeFiles) {
  if (!bundledResources.has(`backend-dist/${file}`)) {
    throw new Error(
      `Backend bridge "${file}" is not listed in tauri.conf.json bundle.resources — ` +
        `it would be missing from the packaged app. Add "backend-dist/${file}".`,
    );
  }
}

const chunks = await readdir(path.join(backendDistDir, "chunks"));
if (!chunks.some((file) => file.endsWith(".mjs"))) {
  throw new Error("Missing bundled backend runtime chunk.");
}

try {
  await access(path.join(backendDistDir, "node_modules"));
  throw new Error("backend-dist must not contain runtime node_modules.");
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}

const nodeSidecarPath = resolveNodeSidecarPath();
await assertExists(nodeSidecarPath, "Missing bundled Node sidecar.");
assertNodeSidecarRuns(nodeSidecarPath);
console.log("Backend runtime bundle check passed.");

async function assertExists(filePath, message) {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}

function resolveNodeSidecarPath() {
  const targetTriple = resolveTauriTargetTriple();
  const extension = process.platform === "win32" ? ".exe" : "";
  return path.join(sidecarDir, `node-${targetTriple}${extension}`);
}

function assertNodeSidecarRuns(sidecarPath) {
  const check = spawnSync(sidecarPath, ["--version"], {
    encoding: "utf8",
  });
  if (check.error || check.status !== 0) {
    const detail = check.stderr?.trim() || check.error?.message || "unknown error";
    throw new Error(`Bundled Node sidecar failed to run: ${detail}`);
  }
}

function resolveTauriTargetTriple() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32") {
    if (arch === "x64") return "x86_64-pc-windows-msvc";
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
  }

  if (platform === "darwin") {
    if (arch === "x64") return "x86_64-apple-darwin";
    if (arch === "arm64") return "aarch64-apple-darwin";
  }

  if (platform === "linux") {
    if (arch === "x64") return "x86_64-unknown-linux-gnu";
    if (arch === "arm64") return "aarch64-unknown-linux-gnu";
  }

  throw new Error(`Unsupported Node sidecar platform: ${platform}/${arch}`);
}
