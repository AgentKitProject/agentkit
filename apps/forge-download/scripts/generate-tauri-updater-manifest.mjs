import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function usage() {
  console.error(`Usage:
  node scripts/generate-tauri-updater-manifest.mjs --metadata <path> --version <version> --release-base-url <url> --assets-dir <dir> --out <path> [--asset-list <path>] [--required-assets-out <path>] [--plan-only]
`);
}

function parseArgs(argv) {
  const values = {};
  const flags = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const key = arg.slice(2);
    if (key === 'plan-only') {
      flags.add(key);
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }

    values[key] = value;
    index += 1;
  }

  return { values, flags };
}

function normalizeVersion(version) {
  return version.replace(/^v/i, '');
}

function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (!value) {
    return [];
  }

  return [value];
}

function basename(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    return path.posix.basename(parsed.pathname);
  } catch {
    return path.posix.basename(trimmed.replaceAll('\\', '/'));
  }
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }

  return undefined;
}

function pickAssetName(entry) {
  const artifact = entry.artifact ?? entry.assetInfo ?? entry.updateAsset ?? {};
  const asset = pickString(
    entry.urlAsset,
    artifact.urlAsset,
    entry.asset,
    entry.assetName,
    entry.file,
    entry.fileName,
    entry.filename,
    entry.path,
    entry.url,
    entry.downloadUrl,
    artifact.asset,
    artifact.assetName,
    artifact.file,
    artifact.fileName,
    artifact.filename,
    artifact.path,
    artifact.url,
    artifact.downloadUrl
  );

  return basename(asset);
}

function pickSignatureAssetName(entry) {
  const signature = entry.signatureInfo ?? entry.signatureAssetInfo ?? {};
  const canonicalSignatureAsset = pickString(entry.signatureAsset, signature.signatureAsset);
  if (canonicalSignatureAsset) {
    return basename(canonicalSignatureAsset);
  }

  const signatureValue = pickString(entry.signature, signature.signature);
  const signatureValueAsset = basename(signatureValue);
  if (signatureValueAsset?.endsWith('.sig')) {
    return signatureValueAsset;
  }

  const signatureAsset = pickString(
    entry.signatureAssetName,
    entry.signatureFile,
    entry.signatureFilename,
    entry.sigAsset,
    entry.sigFile,
    entry.sigFilename,
    entry.signaturePath,
    entry.signatureUrl,
    signature.asset,
    signature.assetName,
    signature.file,
    signature.fileName,
    signature.filename,
    signature.path,
    signature.url,
    signature.downloadUrl
  );

  return basename(signatureAsset);
}

function formatAvailableAssets(assets) {
  if (!assets || assets.size === 0) {
    return 'No available assets were provided.';
  }

  return `Available assets:\n${[...assets].sort().map((asset) => `- ${asset}`).join('\n')}`;
}

function normalizePlatformEntries(metadata) {
  const rawPlatforms =
    metadata.platforms ??
    metadata.updaterPlatforms ??
    metadata.updatePlatforms ??
    metadata.tauriPlatforms;

  if (!rawPlatforms) {
    return [];
  }

  if (Array.isArray(rawPlatforms)) {
    return rawPlatforms.map((entry) => ({
      platform: pickString(entry.platform, entry.target, entry.name, entry.os, entry.arch),
      entry
    }));
  }

  if (typeof rawPlatforms === 'object') {
    return Object.entries(rawPlatforms).map(([platform, entry]) => ({
      platform,
      entry: entry ?? {}
    }));
  }

  return [];
}

async function readOptionalLines(filePath) {
  if (!filePath) {
    return undefined;
  }

  const raw = await readFile(path.resolve(filePath), 'utf8');
  return new Set(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

async function readJson(filePath) {
  const raw = await readFile(path.resolve(filePath), 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));

  if (!values.metadata || !values.version || !values['release-base-url'] || !values['assets-dir'] || !values.out) {
    usage();
    process.exit(1);
  }

  const version = normalizeVersion(values.version);
  const metadataPath = path.resolve(values.metadata);
  const assetsDir = path.resolve(values['assets-dir']);
  const outPath = path.resolve(values.out);
  const releaseBaseUrl = values['release-base-url'].replace(/\/$/, '');
  const metadata = await readJson(metadataPath);
  const availableAssets = await readOptionalLines(values['asset-list']);
  const platformEntries = normalizePlatformEntries(metadata);

  if (platformEntries.length === 0) {
    throw new Error('Updater metadata does not contain any platform entries.');
  }

  const requiredAssets = [];
  const platforms = {};

  for (const { platform, entry } of platformEntries) {
    if (!platform) {
      throw new Error('Updater metadata contains a platform entry without a platform key.');
    }

    const asset = pickAssetName(entry);
    const signatureAsset = pickSignatureAssetName(entry);

    console.log(`Updater platform: ${platform}`);
    console.log(`  urlAsset: ${asset ?? '(missing)'}`);
    console.log(`  signatureAsset: ${signatureAsset ?? '(missing)'}`);

    if (!asset || !signatureAsset) {
      throw new Error(
        `Updater metadata for ${platform} must include non-empty urlAsset and signatureAsset fields.\n${formatAvailableAssets(availableAssets)}`
      );
    }

    if (!signatureAsset.endsWith('.sig')) {
      throw new Error(`Updater signature asset for ${platform} must be a .sig file: ${signatureAsset}`);
    }

    if (availableAssets && !availableAssets.has(asset)) {
      throw new Error(`Updater asset for ${platform} is not present on the GitHub Release: ${asset}\n${formatAvailableAssets(availableAssets)}`);
    }

    if (availableAssets && !availableAssets.has(signatureAsset)) {
      throw new Error(
        `Updater signature asset for ${platform} is not present on the GitHub Release: ${signatureAsset}\n${formatAvailableAssets(availableAssets)}`
      );
    }

    requiredAssets.push(asset, signatureAsset);

    if (!flags.has('plan-only')) {
      const assetPath = path.join(assetsDir, asset);
      const signaturePath = path.join(assetsDir, signatureAsset);
      try {
        await access(assetPath);
      } catch {
        throw new Error(`Updater asset for ${platform} was not downloaded into release-assets: ${asset}`);
      }

      let signature;
      try {
        signature = (await readFile(signaturePath, 'utf8')).trim();
      } catch {
        throw new Error(`Updater signature asset for ${platform} was not downloaded into release-assets: ${signatureAsset}`);
      }

      if (!signature) {
        throw new Error(`Updater signature file for ${platform} is empty: ${signatureAsset}`);
      }

      platforms[platform] = {
        signature,
        url: `${releaseBaseUrl}/${asset}`
      };
    }
  }

  const uniqueRequiredAssets = [...new Set(requiredAssets)];

  if (values['required-assets-out']) {
    await writeFile(path.resolve(values['required-assets-out']), `${uniqueRequiredAssets.join('\n')}\n`, 'utf8');
  }

  if (flags.has('plan-only')) {
    console.log(`Validated updater metadata for ${platformEntries.length} platform(s).`);
    return;
  }

  const notes = pickString(metadata.notes, metadata.body, metadata.releaseNotes) ?? '';
  const pubDate = pickString(metadata.pub_date, metadata.pubDate, metadata.publishedAt, metadata.date) ?? new Date().toISOString();
  const manifest = {
    version,
    notes,
    pub_date: pubDate,
    platforms
  };

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Wrote Tauri updater manifest to ${outPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
