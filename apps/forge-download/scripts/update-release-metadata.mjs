import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function usage() {
  console.error(`Usage:
  node scripts/update-release-metadata.mjs --version <version> [--tag <tag>] [--repository <owner/repo>] [--release-url <url>] [--assets-file <path>] [--metadata-path <path>]
`);
}

function parseArgs(argv) {
  const values = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }

    values[key] = value;
    index += 1;
  }

  return values;
}

function normalizeVersion(version) {
  return version.replace(/^v/i, '');
}

async function readAssetsFile(assetsFile) {
  if (!assetsFile) {
    return [];
  }

  const rawAssets = await readFile(path.resolve(assetsFile), 'utf8');
  return rawAssets
    .split(/\r?\n/)
    .map((asset) => asset.trim())
    .filter(Boolean);
}

function assetUrl(releasePrefix, assetName) {
  return `${releasePrefix}/${assetName}`;
}

function buildPlatformMetadata(version, releasePrefix, assets) {
  const has = (assetName) => assets.includes(assetName);
  const platforms = {};

  const windows = {};
  const setup = `AgentKitForge-${version}-setup.exe`;
  const msi = `AgentKitForge-${version}-x64.msi`;
  const windowsChecksums = `AgentKitForge-${version}-windows-checksums.txt`;
  if (has(setup)) {
    windows.installer = assetUrl(releasePrefix, setup);
    windows.recommended = windows.installer;
  }
  if (has(msi)) {
    windows.msi = assetUrl(releasePrefix, msi);
    windows.recommended ??= windows.msi;
  }
  if (Object.keys(windows).length > 0) {
    if (!has(windowsChecksums)) {
      throw new Error(`Windows artifacts were found but ${windowsChecksums} is missing.`);
    }
    windows.checksums = assetUrl(releasePrefix, windowsChecksums);
    platforms.windows = windows;
  }

  const macos = {};
  const macosDefault = `AgentKitForge-${version}-macos.dmg`;
  const macosUniversal = `AgentKitForge-${version}-macos-universal.dmg`;
  const macosArm64 = `AgentKitForge-${version}-macos-arm64.dmg`;
  const macosX64 = `AgentKitForge-${version}-macos-x64.dmg`;
  const macosChecksums = `AgentKitForge-${version}-macos-checksums.txt`;
  if (has(macosDefault)) {
    macos.default = assetUrl(releasePrefix, macosDefault);
  }
  if (has(macosUniversal)) {
    macos.universal = assetUrl(releasePrefix, macosUniversal);
  }
  if (has(macosArm64)) {
    macos.appleSilicon = assetUrl(releasePrefix, macosArm64);
  }
  if (has(macosX64)) {
    macos.intel = assetUrl(releasePrefix, macosX64);
  }
  if (Object.keys(macos).length > 0) {
    if (!has(macosChecksums)) {
      throw new Error(`macOS artifacts were found but ${macosChecksums} is missing.`);
    }
    macos.checksums = assetUrl(releasePrefix, macosChecksums);
    platforms.macos = macos;
  }

  const linux = {};
  const linuxChecksums = `AgentKitForge-${version}-linux-checksums.txt`;
  const appImage =
    [
      `AgentKitForge-${version}-linux-x86_64.AppImage`,
      `AgentKitForge-${version}-linux-x64.AppImage`,
      `AgentKitForge-${version}-linux-amd64.AppImage`,
      `AgentKitForge-${version}-linux.AppImage`
    ].find(has);
  const deb =
    [
      `AgentKitForge-${version}-linux-amd64.deb`,
      `AgentKitForge-${version}-linux-x86_64.deb`,
      `AgentKitForge-${version}-linux.deb`
    ].find(has);
  const rpm =
    [
      `AgentKitForge-${version}-linux-x86_64.rpm`,
      `AgentKitForge-${version}-linux-amd64.rpm`,
      `AgentKitForge-${version}-linux.rpm`
    ].find(has);

  if (appImage) {
    linux.appImage = assetUrl(releasePrefix, appImage);
  }
  if (deb) {
    linux.deb = assetUrl(releasePrefix, deb);
  }
  if (rpm) {
    linux.rpm = assetUrl(releasePrefix, rpm);
  }
  if (Object.keys(linux).length > 0) {
    if (!has(linuxChecksums)) {
      throw new Error(`Linux artifacts were found but ${linuxChecksums} is missing.`);
    }
    linux.checksums = assetUrl(releasePrefix, linuxChecksums);
    platforms.linux = linux;
  }

  return platforms;
}

const args = parseArgs(process.argv.slice(2));

if (!args.version) {
  usage();
  process.exit(1);
}

const version = normalizeVersion(args.version);
const tag = args.tag || `v${version}`;
const repository = args.repository || 'AgentKitProject/agentkitforge-app';
const releaseUrl = args['release-url'] || `https://github.com/${repository}/releases/tag/${tag}`;
const releasePrefix = `/releases/v${version}`;
const mirroredAssets = await readAssetsFile(args['assets-file']);

// Path to releases.json. Defaults to this app's data file relative to the repo
// (the script is invoked with the monorepo root, or apps/forge-download, as cwd;
// pass --metadata-path to override). Moved here from agentkitforge-infra/site
// during the M4 AWS->DO migration.
const metadataPath = path.resolve(
  args['metadata-path'] || 'apps/forge-download/src/data/releases.json'
);
const raw = await readFile(metadataPath, 'utf8');
const metadata = JSON.parse(raw);
const releases = Array.isArray(metadata.releases) ? metadata.releases : [];
const date = new Date().toISOString().slice(0, 10);
const assetsForMetadata = mirroredAssets;
const notesAsset = 'RELEASE_NOTES.md';
const platforms = buildPlatformMetadata(version, releasePrefix, assetsForMetadata);

if (Object.keys(platforms).length === 0) {
  throw new Error(`No release artifacts found for v${version}.`);
}

const nextRelease = {
  version,
  tag,
  channel: 'public-preview',
  title: `AgentKitForge v${version} Public Preview`,
  date,
  repository,
  releaseUrl,
  platforms
};

if (assetsForMetadata.includes(notesAsset)) {
  nextRelease.notes = assetUrl(releasePrefix, notesAsset);
}

const filtered = releases.filter((release) => release.version !== version);
filtered.unshift(nextRelease);

metadata.latest = version;
metadata.releases = filtered;

await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
