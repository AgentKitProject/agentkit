import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { rollup } from "rollup";
import { builtinModules } from "node:module";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceBackendDir = path.join(root, "src-tauri", "backend");
const distBackendDir = path.join(root, "src-tauri", "backend-dist");
const sidecarDir = path.join(root, "src-tauri", "binaries");
const tempBackendDir = path.join(root, "src-tauri", ".backend-build");

await rm(distBackendDir, { force: true, recursive: true });
await rm(tempBackendDir, { force: true, recursive: true });
await mkdir(distBackendDir, { recursive: true });
await mkdir(tempBackendDir, { recursive: true });

const backendFiles = (await readdir(sourceBackendDir)).filter((file) => file.endsWith(".mjs"));
for (const file of backendFiles) {
  const sourcePath = path.join(sourceBackendDir, file);
  const tempPath = path.join(tempBackendDir, file);
  const source = await readFile(sourcePath, "utf8");
  await writeFile(tempPath, preparePackagedBridgeSource(source));
}

const bundle = await rollup({
  input: Object.fromEntries(
    backendFiles.map((file) => [path.basename(file, ".mjs"), path.join(tempBackendDir, file)]),
  ),
  external: [
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
  ],
  plugins: [
    nodeResolve({
      exportConditions: ["node", "import", "default"],
      preferBuiltins: true,
    }),
    commonjs(),
  ],
  treeshake: true,
  onwarn(warning, warn) {
    if (warning.code === "CIRCULAR_DEPENDENCY" || warning.code === "UNUSED_EXTERNAL_IMPORT") {
      return;
    }
    warn(warning);
  },
});

await bundle.write({
  dir: distBackendDir,
  format: "esm",
  entryFileNames: "[name].mjs",
  chunkFileNames: "chunks/[name]-[hash].mjs",
  sourcemap: false,
});
await bundle.close();

await rm(tempBackendDir, { force: true, recursive: true });
await prepareNodeSidecar();

console.log(`Bundled ${backendFiles.length} backend bridge file(s) into ${path.relative(root, distBackendDir)}.`);

function preparePackagedBridgeSource(source) {
  return source
    .replaceAll(
      'process.env.AGENTKITFORGE_ALLOW_DEV_OVERRIDES === "1"',
      '"0" === "1"',
    )
    .replace(
      /async function loadCore\(\) \{[\s\S]*?\n\}/,
      'async function loadCore() {\n  return import("@agentkitforge/core");\n}',
    )
    .replace(
      /async function loadCoreMarket\(\) \{[\s\S]*?\n\}/,
      'async function loadCoreMarket() {\n  return import("@agentkitforge/core/market");\n}',
    )
    .replace(
      /async function loadCoreGateway\(\) \{[\s\S]*?\n\}/,
      'async function loadCoreGateway() {\n  return import("@agentkitforge/core/gateway");\n}',
    );
}

async function prepareNodeSidecar() {
  const targetTriple = resolveTauriTargetTriple();
  const extension = process.platform === "win32" ? ".exe" : "";
  const sidecarPath = path.join(sidecarDir, `node-${targetTriple}${extension}`);

  await mkdir(sidecarDir, { recursive: true });
  const { sourceNodePath, rejected } = await prepareNodeSidecarFromCandidates(sidecarPath);
  if (sourceNodePath) {
    console.log(`Prepared Node sidecar at ${path.relative(root, sidecarPath)} from ${sourceNodePath}.`);
    return;
  }
  throw new Error(
    [
      "No bundleable Node sidecar candidate was found for packaged builds.",
      "Install a standalone Node binary or set AGENTKITFORGE_NODE_SIDECAR=/absolute/path/to/node.",
      rejected.length ? `Rejected candidates:\n${rejected.map((entry) => `- ${entry}`).join("\n")}` : "",
    ].filter(Boolean).join("\n"),
  );
}

async function prepareNodeSidecarFromCandidates(sidecarPath) {
  const overridePath = process.env.AGENTKITFORGE_NODE_SIDECAR?.trim();
  const candidates = overridePath
    ? [path.resolve(overridePath)]
    : [
        process.execPath,
        "/Applications/AgentKitForge.app/Contents/MacOS/node",
        sidecarPath,
      ];
  const rejected = [];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) {
      rejected.push(`${candidate}: file does not exist`);
      continue;
    }
    const bundleable = nodeSidecarBundleability(candidate);
    if (!bundleable.ok) {
      rejected.push(`${candidate}: ${bundleable.reason}`);
      continue;
    }
    const runnable = nodeSidecarRuns(candidate);
    if (!runnable.ok) {
      rejected.push(`${candidate}: ${runnable.reason}`);
      continue;
    }

    try {
      if (path.resolve(candidate) !== path.resolve(sidecarPath)) {
        await copyFile(candidate, sidecarPath);
      }
      if (process.platform !== "win32") {
        await chmod(sidecarPath, 0o755);
      }
      const prepared = nodeSidecarRuns(sidecarPath);
      if (!prepared.ok) {
        rejected.push(`${candidate}: prepared sidecar check failed: ${prepared.reason}`);
        continue;
      }
    } catch (error) {
      rejected.push(`${candidate}: unable to prepare sidecar: ${error.message}`);
      continue;
    }

    if (!overridePath && candidate !== process.execPath) {
      console.log(`Using fallback Node sidecar candidate: ${candidate}`);
    }
    return { sourceNodePath: path.resolve(candidate), rejected };
  }
  return { sourceNodePath: null, rejected };
}

function nodeSidecarBundleability(sourceNodePath) {
  if (process.platform !== "darwin") {
    return { ok: true };
  }

  const otool = spawnSync("otool", ["-L", sourceNodePath], {
    encoding: "utf8",
  });
  if (otool.error || otool.status !== 0) {
    const detail = otool.stderr?.trim() || otool.error?.message || "unknown error";
    return { ok: false, reason: `Unable to inspect Node sidecar candidate with otool: ${detail}` };
  }

  const unresolvedRpathDependencies = otool.stdout
    .split("\n")
    .map((line) => line.trim().split(" ")[0])
    .filter((dependency) => dependency.startsWith("@rpath/"));

  if (unresolvedRpathDependencies.length > 0) {
    return {
      ok: false,
      reason: [
        `Node sidecar candidate is dynamically linked and cannot be copied as a standalone Tauri sidecar: ${sourceNodePath}`,
        `Unbundled @rpath dependencies: ${unresolvedRpathDependencies.join(", ")}`,
      ].join("\n"),
    };
  }

  return { ok: true };
}

function nodeSidecarRuns(sidecarPath) {
  const check = spawnSync(sidecarPath, ["--version"], {
    encoding: "utf8",
  });
  if (check.error || check.status !== 0) {
    const detail = check.stderr?.trim() || check.error?.message || "unknown error";
    return { ok: false, reason: `Node sidecar failed to start: ${detail}` };
  }
  return { ok: true };
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
