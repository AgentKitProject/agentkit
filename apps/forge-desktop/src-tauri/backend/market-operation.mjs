import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";

/**
 * One-shot hosted-AgentKitMarket operation bridge.
 *
 * Protocol (the access/refresh tokens must NEVER appear in argv/process list):
 *   - STDIN: a single JSON request object:
 *       {
 *         "op": "submit" | "import" | "download" | "update-check"
 *             | "list-favorites" | "add-favorite" | "remove-favorite",
 *         "session": { accessToken, refreshToken?, user?, connectedAt? },
 *         "params": { ... }          // op-specific (see below)
 *       }
 *   - STDOUT: a single JSON response object:
 *       { "ok": true, "result": <op result>, "rotatedSession"?: <session> }
 *     or
 *       { "ok": false, "error": <safe message> }
 *
 * `rotatedSession` is present only when core refreshed the WorkOS session during
 * the operation (captured by the in-memory store below). The Rust host persists
 * it back into OS secure storage. Token values are never written to stdout logs.
 *
 * Per the core-parity design, core (`@agentkitforge/core/market`) OWNS all token
 * refresh during the operation via `ensureAccessToken` + the once-on-401 retry.
 * The Rust host only seeds the store with the current stored session and a
 * WorkOS client id; it does not refresh in parallel with the bridge.
 *
 * submit params:    { rootPath, publisherId, marketBaseUrl?, clientId? }
 * import params:    { slug, kitId?, marketBaseUrl?, targetDir?, clientId? }
 * download params:  { slug, kitId?, marketBaseUrl?, outputPath, clientId? }
 *   (download writes the .agentkit.zip bytes to `outputPath` and returns
 *    provenance only — the app keeps its own package-import + library
 *    persistence, so no kit bytes cross the JSON boundary.)
 * update-check params: { marketBaseUrl, slug, installedVersion }
 *   (TOKENLESS public read of the catalog; no session required or seeded.
 *    Returns { available, latestVersion?, updateAvailable, reason }.)
 * licensed-package params: { slug, kitId?, marketBaseUrl?, clientId? }
 *   (Tier-2 paid/licensed kits. Fetches the entitlement-gated, watermarked
 *    package IN MEMORY via core's `fetchLicensedKit` — bytes NEVER touch disk
 *    inside this bridge. For ONLINE-ONLY kits (`onlineOnly === true`) the raw
 *    bytes are NEVER returned over the JSON boundary; only an in-memory preview
 *    (metadata + selected text files + file list, parsed from the zip in
 *    memory) is returned, so the host has nothing to persist. For DOWNLOADABLE
 *    paid kits the user is entitled to, the watermarked bytes ARE returned as
 *    base64 so the host can save+import THOSE (never the public download).
 *    Returns { onlineOnly, pricing, downloadable, kitId, fileName, sha256,
 *      licenseVersion, entitlementId, preview, contentBase64? }.)
 */

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", (error) => reject(error));
  });
}

/**
 * In-memory TokenStore seeded with the current session. `set()` captures the
 * latest session so a refresh that happens mid-operation is reported back to the
 * host. `get()` always returns the latest captured session.
 */
function createCaptureStore(initialSession) {
  let current = initialSession ? { ...initialSession } : null;
  let rotated = false;
  return {
    store: {
      async get() {
        return current ? { ...current } : null;
      },
      async set(session) {
        current = { ...session };
        rotated = true;
      },
      async clear() {
        current = null;
        rotated = true;
      },
    },
    snapshot() {
      return { rotated, session: current };
    },
  };
}

function normalizeSession(session) {
  if (!session || typeof session !== "object") {
    return null;
  }
  const accessToken =
    typeof session.accessToken === "string" ? session.accessToken : "";
  if (accessToken.trim() === "") {
    return null;
  }
  return {
    accessToken,
    refreshToken:
      typeof session.refreshToken === "string" ? session.refreshToken : undefined,
    user:
      session.user && typeof session.user === "object" ? session.user : undefined,
    connectedAt:
      typeof session.connectedAt === "string" && session.connectedAt.trim() !== ""
        ? session.connectedAt
        : new Date().toISOString(),
  };
}

async function runSubmit(market, store, params) {
  const result = await market.submitKit(store, {
    rootPath: params.rootPath,
    publisherId: params.publisherId,
    marketBaseUrl: params.marketBaseUrl,
    clientId: params.clientId,
  });
  return {
    submissionId: result.submissionId,
    status: result.status,
    marketLink: result.marketLink,
    sha256: result.sha256,
    packagePath: result.packagePath,
    validationReport: result.validationReport,
  };
}

async function runImport(market, store, params) {
  const result = await market.importKit(store, {
    slug: params.slug,
    kitId: params.kitId,
    marketBaseUrl: params.marketBaseUrl,
    targetDir: params.targetDir,
    clientId: params.clientId,
  });
  return {
    rootPath: result.rootPath,
    inspection: result.inspection,
    provenance: result.provenance,
  };
}

async function runUpdateCheck(market, params) {
  // Tokenless public read against the AgentKitMarket catalog. No session is
  // required or seeded — this only reports whether a newer published version
  // exists; it never downloads or installs anything.
  const status = await market.checkKitUpdate({
    marketBaseUrl: params.marketBaseUrl,
    slug: params.slug,
    installedVersion: params.installedVersion,
  });
  return {
    available: status.available,
    latestVersion: status.latestVersion,
    updateAvailable: status.updateAvailable,
    reason: status.reason,
  };
}

async function runDownload(market, store, params) {
  const { bytes, provenance } = await market.downloadKit(store, {
    slug: params.slug,
    kitId: params.kitId,
    marketBaseUrl: params.marketBaseUrl,
    clientId: params.clientId,
  });
  const outputPath = params.outputPath;
  if (typeof outputPath !== "string" || outputPath.trim() === "") {
    throw new Error("Market download bridge requires an output path.");
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);
  return { outputPath, provenance };
}

const MAX_PREVIEW_TEXT_BYTES = 64 * 1024;
const PREVIEW_TEXT_CANDIDATES = ["agentkit.yaml", "AGENTKIT.md", "START_HERE.md"];

/**
 * Build a read-only, in-memory preview of a licensed kit from its zip bytes.
 * Parses the package entirely in memory (JSZip) and NEVER writes to disk.
 * Returns kit metadata, a small set of human-readable text files, and the full
 * entry list so the UI can render a read-only view without persisting anything.
 */
async function buildInMemoryPreview(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const files = [];
  zip.forEach((relativePath, entry) => {
    if (!entry.dir) {
      files.push(relativePath);
    }
  });
  files.sort();

  const texts = {};
  for (const name of PREVIEW_TEXT_CANDIDATES) {
    const entry = zip.file(name);
    if (!entry) continue;
    const content = await entry.async("string");
    texts[name] =
      content.length > MAX_PREVIEW_TEXT_BYTES
        ? `${content.slice(0, MAX_PREVIEW_TEXT_BYTES)}\n\n[Preview truncated]`
        : content;
  }

  return { files, texts };
}

async function runLicensedPackage(market, store, params) {
  // Fetch the entitlement-gated, watermarked package IN MEMORY. Core verifies
  // the sha256 against the returned bytes and surfaces `onlineOnly`.
  const licensed = await market.fetchLicensedKit(store, {
    slug: params.slug ?? params.kitId,
    marketBaseUrl: params.marketBaseUrl,
    clientId: params.clientId,
  });

  const preview = await buildInMemoryPreview(licensed.bytes);

  const base = {
    onlineOnly: licensed.onlineOnly === true,
    pricing: licensed.pricing,
    downloadable: licensed.downloadable === true,
    kitId: licensed.kitId,
    fileName: licensed.fileName,
    sha256: licensed.sha256,
    licenseVersion: licensed.licenseVersion,
    entitlementId: licensed.entitlementId,
    preview,
  };

  if (base.onlineOnly) {
    // ONLINE-ONLY: do NOT write the bytes anywhere. They stay only in this Node
    // process and are discarded when it exits — nothing for the host to persist.
    return { ...base, savedPath: null };
  }

  // DOWNLOADABLE paid kit the user is entitled to: write the WATERMARKED bytes
  // to the host-provided temp path so the host imports THESE, never the public
  // download. (Same disk-write discipline as `runDownload`.)
  const outputPath = params.outputPath;
  if (typeof outputPath !== "string" || outputPath.trim() === "") {
    throw new Error("Licensed-package bridge requires an output path for downloadable kits.");
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, licensed.bytes);
  return { ...base, savedPath: outputPath };
}

async function runListFavorites(market, store, params) {
  const items = await market.listFavorites(store, {
    marketBaseUrl: params.marketBaseUrl,
    clientId: params.clientId,
  });
  return { items };
}

async function runAddFavorite(market, store, params) {
  const items = await market.addFavorite(
    store,
    { slug: params.slug, kitId: params.kitId },
    { marketBaseUrl: params.marketBaseUrl, clientId: params.clientId },
  );
  return { items };
}

async function runRemoveFavorite(market, store, params) {
  await market.removeFavorite(store, params.kitId, {
    marketBaseUrl: params.marketBaseUrl,
    clientId: params.clientId,
  });
  return { kitId: params.kitId };
}

async function main() {
  const raw = await readStdin();
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    throw new Error("Market operation bridge received an invalid request.");
  }
  const op = request?.op;
  const params = request?.params ?? {};
  const session = normalizeSession(request?.session);

  const capture = createCaptureStore(session);
  const market = await loadCoreMarket();

  let result;
  if (op === "submit") {
    result = await runSubmit(market, capture.store, params);
  } else if (op === "import") {
    result = await runImport(market, capture.store, params);
  } else if (op === "download") {
    result = await runDownload(market, capture.store, params);
  } else if (op === "licensed-package") {
    result = await runLicensedPackage(market, capture.store, params);
  } else if (op === "list-favorites") {
    result = await runListFavorites(market, capture.store, params);
  } else if (op === "add-favorite") {
    result = await runAddFavorite(market, capture.store, params);
  } else if (op === "remove-favorite") {
    result = await runRemoveFavorite(market, capture.store, params);
  } else if (op === "update-check") {
    // Tokenless: ignore any session, do not seed or rotate one.
    result = await runUpdateCheck(market, params);
  } else {
    throw new Error(`Unsupported Market operation: ${String(op)}.`);
  }

  const { rotated, session: latest } = capture.snapshot();
  const response = { ok: true, result };
  if (rotated && latest) {
    response.rotatedSession = latest;
  }
  process.stdout.write(JSON.stringify(response));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  // Structured failure on stdout so the host can map it to a user-facing
  // message; a non-zero exit also flags failure for the host.
  process.stdout.write(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
});

async function loadCoreMarket() {
  if (process.env.AGENTKITFORGE_ALLOW_DEV_OVERRIDES === "1" && process.env.AGENTKITFORGE_CORE_PATH) {
    const entry = path.join(process.env.AGENTKITFORGE_CORE_PATH, "dist", "market", "index.js");
    return import(pathToFileURL(entry).href);
  }

  const siblingEntry = path.resolve(
    process.cwd(),
    "..",
    "agentkitforge-core",
    "dist",
    "market",
    "index.js",
  );
  try {
    return await import(pathToFileURL(siblingEntry).href);
  } catch {
    // Fall back to the installed package subpath.
  }

  return import("@agentkitforge/core/market");
}
