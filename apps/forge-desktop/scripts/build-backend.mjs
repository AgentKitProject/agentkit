import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { rollup } from "rollup";
import { builtinModules } from "node:module";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceBackendDir = path.join(root, "src-tauri", "backend");
const distBackendDir = path.join(root, "src-tauri", "backend-dist");
const tempBackendDir = path.join(root, "src-tauri", ".backend-build");

// Resolve bare imports against this app package (not the temp build dir, which
// sits outside node_modules). In the pnpm/Turborepo monorepo, workspace deps
// (@agentkitforge/core) and direct deps (jszip) are symlinked into this app's
// node_modules; the temp .backend-build dir is not, so node-resolve must be
// anchored at the package root to find them. Core's own transitive deps
// (yaml/zod/commander/contracts) resolve from core's node_modules as usual.
const moduleResolveRoots = [path.join(root, "node_modules")];

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
      // Anchor module resolution at this app's node_modules so pnpm-symlinked
      // workspace + direct deps resolve even though the bridge sources are
      // bundled from a temp dir outside node_modules.
      modulePaths: moduleResolveRoots,
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

console.log(`Bundled ${backendFiles.length} backend bridge file(s) into ${path.relative(root, distBackendDir)}.`);
// Note: staging the standalone Node sidecar binary is a Tauri *packaging*
// concern (it needs a statically-linkable Node, unavailable in plain dev/CI),
// so it lives in scripts/prepare-node-sidecar.mjs and runs from build:tauri —
// not here. This keeps `build`/`build:backend` runnable under `turbo run build`
// without the Rust toolchain or a release-grade Node binary.

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
