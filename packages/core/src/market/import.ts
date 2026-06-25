/**
 * Hosted-AgentKitMarket import operation, ported from the Rust
 * `import_hosted_market_kit` (minus app-side "My Kits library" persistence,
 * which intentionally stays in the desktop app).
 *
 * Flow: downloadKit → extract the .agentkit.zip to a directory (caller-provided
 * or a temp dir) using the engine's path-safety guards → inspect the extracted
 * candidate with the engine's `inspectAgentKitCandidate` → return the
 * inspection plus provenance metadata.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

import {
  inspectAgentKitCandidate,
  type AgentKitCandidateInspection
} from "../app/inspect.js";
import { assertSafeRelativePath, resolveInside } from "../fs/safety.js";

import {
  downloadKit,
  type DownloadKitOptions,
  type MarketProvenance
} from "./download.js";
import type { TokenStore } from "./types.js";

/** Per-package extraction safeguards, aligned with the spec packaging limits. */
const MAX_ENTRIES = 2000;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

export interface ImportKitOptions extends DownloadKitOptions {
  /**
   * Directory to extract the kit into. If omitted, a temp directory is created
   * (the path is returned in the result). Extraction is headless; no library
   * persistence happens here.
   */
  targetDir?: string;
}

export interface ImportKitResult {
  /** Directory the kit was extracted to. */
  rootPath: string;
  /** The engine's validation/candidate inspection of the extracted kit. */
  inspection: AgentKitCandidateInspection;
  /** Provenance metadata for Bridge 5 (source, marketBaseUrl, sha256, ...). */
  provenance: MarketProvenance;
}

/**
 * Safely extract a .agentkit.zip buffer into `targetDir`, enforcing entry
 * count, per-file and total uncompressed size limits, and rejecting path
 * traversal. Directories are created as needed.
 */
export async function extractAgentKitZip(
  bytes: Uint8Array,
  targetDir: string
): Promise<void> {
  const zip = await JSZip.loadAsync(bytes);
  const fileEntries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (fileEntries.length > MAX_ENTRIES) {
    throw new Error(
      `Market package has too many entries (${fileEntries.length} > ${MAX_ENTRIES}).`
    );
  }
  await mkdir(targetDir, { recursive: true });
  let totalBytes = 0;
  for (const entry of fileEntries) {
    assertSafeRelativePath(entry.name);
    const destination = resolveInside(targetDir, entry.name);
    const content = await entry.async("uint8array");
    if (content.length > MAX_FILE_BYTES) {
      throw new Error(
        `Market package file is too large: ${entry.name} (${content.length} bytes).`
      );
    }
    totalBytes += content.length;
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(
        "Market package exceeds the maximum uncompressed size of 100MB."
      );
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}

/**
 * Download, extract, and inspect a hosted-Market kit. Returns the extraction
 * path, the engine inspection, and provenance metadata. Does NOT persist to any
 * "My Kits" library — that remains the desktop app's responsibility.
 */
export async function importKit(
  store: TokenStore,
  options: ImportKitOptions
): Promise<ImportKitResult> {
  const { bytes, provenance } = await downloadKit(store, options);

  const rootPath =
    options.targetDir ??
    (await mkdtemp(path.join(os.tmpdir(), "agentkitforge-market-import-")));

  await extractAgentKitZip(bytes, rootPath);
  const inspection = await inspectAgentKitCandidate(rootPath);

  return { rootPath, inspection, provenance };
}
