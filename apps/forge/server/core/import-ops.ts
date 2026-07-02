// Import operations that bring an external kit into the user's KitStore.
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadCoreMarket } from "@/server/core/load-core";
import { readTreeFromDir } from "@/server/core/runner";
import { getKitStore } from "@/server/store/local-disk";
import { assertKitValid, unzipToTree, KitValidationError } from "@/server/core/operations";
import { getWorkosAccessToken } from "@/server/core/market-auth";
import type { TokenStore } from "@agentkitforge/core/market";

// Re-export so route error handlers can detect this type.
export { KitValidationError };

const execFileAsync = promisify(execFile);

// --- import from git (server-side clone) -------------------------------------
export async function importFromGit(
  userId: string,
  repositoryUrl: string,
  reference: string
): Promise<{ kitId: string }> {
  if (!/^https?:\/\//i.test(repositoryUrl)) {
    throw new Error("Only http(s) git URLs are supported.");
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "akf-git-"));
  try {
    const dest = path.join(tmp, "repo");
    // Shallow clone, then optionally checkout the requested ref.
    await execFileAsync("git", ["clone", "--depth", "1", repositoryUrl, dest], { timeout: 120_000 });
    if (reference && reference.trim()) {
      await execFileAsync("git", ["-C", dest, "fetch", "--depth", "1", "origin", reference], { timeout: 120_000 }).catch(
        () => undefined
      );
      await execFileAsync("git", ["-C", dest, "checkout", reference], { timeout: 60_000 });
    }
    // Drop the .git dir so it is not persisted into the kit tree.
    await fs.rm(path.join(dest, ".git"), { recursive: true, force: true });
    const tree = await readTreeFromDir(dest);
    // Gate: reject non-kit repositories.
    await assertKitValid(tree);
    const meta = await (await getKitStore()).createKit(userId, { kind: "tree", tree, source: "git" });
    return { kitId: meta.kitId };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// --- import from Market (via core market client) -----------------------------
// Uses the public download path; persists the imported tree into the KitStore.
export async function importFromMarket(
  userId: string,
  params: { slug: string; kitId?: string; marketBaseUrl?: string; clientId?: string }
): Promise<{ kitId: string; provenance?: unknown }> {
  const market = await loadCoreMarket();
  // Seed the user's WorkOS access token (cookie session) so entitled/private
  // downloads authenticate; falls back to tokenless for public kits.
  const store = await createForwardingStore();
  const { bytes, provenance } = await market.downloadKit(store as never, {
    slug: params.slug,
    kitId: params.kitId,
    marketBaseUrl: params.marketBaseUrl,
    clientId: params.clientId ?? ""
  });
  const tree = await unzipToTree(Buffer.from(bytes));
  // Gate: validate before persisting. Market kits should always be valid; this
  // also protects against malicious/misconfigured Market instances.
  await assertKitValid(tree);
  const meta = await (await getKitStore()).createKit(userId, { kind: "tree", tree, source: "market-import" });
  return { kitId: meta.kitId, provenance };
}

// A TokenStore that forwards the user's WorkOS access token (from the AuthKit
// cookie session) to the Market client when a session exists, and degrades to a
// tokenless store for public reads when there is none. This enables
// entitled/private downloads while keeping public imports working logged-out
// of any device-auth flow.
export async function createForwardingStore(): Promise<TokenStore> {
  const accessToken = await getWorkosAccessToken();
  return {
    async get() {
      const fresh = await getWorkosAccessToken();
      const token = fresh ?? accessToken;
      return token ? { accessToken: token, connectedAt: new Date().toISOString() } : null;
    },
    async set() {
      /* cookie session owns the token lifecycle */
    },
    async clear() {
      /* cookie session owns the token lifecycle */
    }
  };
}
