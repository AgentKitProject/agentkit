import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = process.platform === "win32" ? ".exe" : "";
const releaseDir = path.join(root, "src-tauri", "target", "release");
const sidecarName = `node${extension}`;
const sidecarPath = path.join(releaseDir, sidecarName);

try {
  await access(sidecarPath);
} catch {
  throw new Error(`Missing Tauri release sidecar: ${path.relative(root, sidecarPath)}`);
}
assertNodeSidecarRuns(sidecarPath);

const depInfoPath = path.join(releaseDir, "agentkitforge-app.d");
try {
  const depInfo = await readFile(depInfoPath, "utf8");
  if (!depInfo.includes("backend-dist")) {
    throw new Error("Tauri release dependency file does not reference backend-dist resources.");
  }
  if (!depInfo.includes(resolveExpectedSourceSidecarName())) {
    throw new Error("Tauri release dependency file does not reference the platform Node sidecar source.");
  }
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
  await verifyBundleDirectoryContainsRuntimeResources();
}

console.log(`Tauri packaged runtime check passed: ${path.relative(root, sidecarPath)}`);

function assertNodeSidecarRuns(nodePath) {
  const check = spawnSync(nodePath, ["--version"], {
    encoding: "utf8",
  });
  if (check.error || check.status !== 0) {
    const detail = check.stderr?.trim() || check.error?.message || "unknown error";
    throw new Error(`Tauri release Node sidecar failed to run: ${detail}`);
  }
}

function resolveExpectedSourceSidecarName() {
  const targetTriple = resolveTauriTargetTriple();
  return `node-${targetTriple}${extension}`;
}

async function verifyBundleDirectoryContainsRuntimeResources() {
  const bundleDir = path.join(releaseDir, "bundle");
  const files = await collectFiles(bundleDir);
  if (!files.some((file) => file.includes("backend-dist"))) {
    throw new Error("Tauri bundle output does not appear to include backend-dist resources.");
  }
  if (!files.some((file) => path.basename(file) === sidecarName)) {
    throw new Error("Tauri bundle output does not appear to include the Node sidecar.");
  }
}

async function collectFiles(directory) {
  const output = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...await collectFiles(fullPath));
    } else if (entry.isFile()) {
      output.push(fullPath);
    }
  }
  return output;
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
