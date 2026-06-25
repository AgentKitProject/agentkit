import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");
const forwardedArgs = localTauriBuildArgs(process.argv.slice(2));

const build = spawnSync(tauriBin, ["build", ...forwardedArgs], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  // On Windows the bin is tauri.cmd; Node 24+ refuses to spawn .cmd files
  // directly (EINVAL, no output), so route through the shell there.
  shell: process.platform === "win32",
});

if (build.status !== 0) {
  console.error("Tauri build failed.");
  process.exit(build.status ?? 1);
}

if (!signLocalMacosAppIfNeeded()) {
  process.exit(1);
}

process.exit(0);

function localTauriBuildArgs(args) {
  if (process.platform !== "darwin" || args.includes("--bundles") || args.includes("-b")) {
    return args;
  }
  console.log("Local macOS build: defaulting to --bundles app to avoid Tauri's generated DMG wrapper.");
  return [...args, "--bundles", "app"];
}

function signLocalMacosAppIfNeeded() {
  if (process.platform !== "darwin" || process.env.CI === "true" || process.env.APPLE_SIGNING_IDENTITY_HASH) {
    return true;
  }

  const bundleDir = path.join(root, "src-tauri", "target", "release", "bundle", "macos");
  const appPath = findBuiltApp(bundleDir);
  if (!appPath) {
    return true;
  }

  const executablePath = path.join(appPath, "Contents", "MacOS", "agentkitforge-app");
  const nodePath = path.join(appPath, "Contents", "MacOS", "node");
  const nodeEntitlementsPath = path.join(root, "src-tauri", "entitlements", "node-sidecar.entitlements.plist");
  const appIdentifier = "com.agentkitforge.desktop";

  console.log("Local macOS build: signing AgentKitForge.app ad-hoc with stable bundle identity for Keychain testing.");

  if (existsSync(nodePath)) {
    const nodeArgs = ["--force", "--options", "runtime", "--timestamp=none", "--sign", "-"];
    if (existsSync(nodeEntitlementsPath)) {
      nodeArgs.push("--entitlements", nodeEntitlementsPath);
    }
    nodeArgs.push(nodePath);
    if (!runCodesign(nodeArgs, "Unable to sign bundled Node sidecar for local macOS build.")) {
      return false;
    }
  }

  if (existsSync(executablePath)) {
    if (
      !runCodesign(
        ["--force", "--options", "runtime", "--timestamp=none", "--sign", "-", "--identifier", appIdentifier, executablePath],
        "Unable to sign main executable for local macOS build.",
      )
    ) {
      return false;
    }
  }

  if (
    !runCodesign(
      ["--force", "--options", "runtime", "--timestamp=none", "--sign", "-", "--identifier", appIdentifier, appPath],
      "Unable to sign app bundle for local macOS build.",
    )
  ) {
    return false;
  }

  return runCodesign(["--verify", "--deep", "--strict", "--verbose=2", appPath], "Local macOS app signature verification failed.");
}

function findBuiltApp(bundleDir) {
  if (!existsSync(bundleDir)) {
    return null;
  }

  const apps = readdirSync(bundleDir)
    .filter((entry) => entry.endsWith(".app"))
    .map((entry) => path.join(bundleDir, entry));
  return apps.find((appPath) => path.basename(appPath) === "AgentKitForge.app") ?? apps[0] ?? null;
}

function runCodesign(args, errorMessage) {
  const result = spawnSync("codesign", args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(errorMessage);
    return false;
  }
  return true;
}
