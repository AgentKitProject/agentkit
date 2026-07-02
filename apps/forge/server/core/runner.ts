// Core runner — the key trick of the web backend.
//
// @agentkitforge/core operates on a kit *directory* on disk. The web backend
// has no per-user FS, so for each operation we:
//   1. MATERIALIZE the kit's file tree from the KitStore into an ephemeral temp
//      dir (os.tmpdir + mkdtemp),
//   2. run the relevant core function against that temp dir (the same logic the
//      desktop .mjs bridge scripts call),
//   3. optionally PERSIST the (mutated) tree back to the KitStore,
//   4. ALWAYS clean up the temp dir (try/finally).
//
// Package/export operations return bytes/text to the caller for web download
// rather than writing to a user path — there is no user path on the web.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCore } from "@/server/core/load-core";
import { getKitStore } from "@/server/store/local-disk";
import type { KitFile, KitTree } from "@/server/store/types";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "akf-web-"));
}

function normalizeRelPath(rel: string): string {
  const norm = path.posix.normalize(rel.replace(/\\/g, "/"));
  if (norm.startsWith("/") || norm.startsWith("..") || norm.includes("\0")) {
    throw new Error(`Invalid file path: ${rel}`);
  }
  return norm;
}

function isProbablyText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  for (const byte of sample) {
    if (byte === 0) return false;
  }
  return true;
}

export async function writeTreeToDir(root: string, tree: KitTree): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  for (const file of tree.files) {
    const rel = normalizeRelPath(file.path);
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const buf = file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
    await fs.writeFile(abs, buf);
  }
}

export async function readTreeFromDir(root: string): Promise<KitTree> {
  const files: KitFile[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        const buf = await fs.readFile(abs);
        files.push(
          isProbablyText(buf)
            ? { path: rel, content: buf.toString("utf8"), encoding: "utf8" }
            : { path: rel, content: buf.toString("base64"), encoding: "base64" }
        );
      }
    }
  }
  await walk(root, "");
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files };
}

export type RunnerContext = {
  /** Absolute path to the materialized kit root inside the temp dir. */
  kitRoot: string;
  /** The parent temp dir (use for sibling output dirs, e.g. exports). */
  tmpDir: string;
  core: Awaited<ReturnType<typeof loadCore>>;
};

/**
 * Materialize a user's kit, run `fn` against it, optionally persist the mutated
 * tree back, and always clean up. Returns whatever `fn` returns.
 */
export async function withMaterializedKit<T>(
  userId: string,
  kitId: string,
  fn: (ctx: RunnerContext) => Promise<T>,
  options: { persist?: boolean } = {}
): Promise<T> {
  const store = await getKitStore();
  const tree = await store.getKitTree(userId, kitId);
  const core = await loadCore();
  const tmpDir = await makeTempDir();
  const kitRoot = path.join(tmpDir, "kit");
  try {
    await writeTreeToDir(kitRoot, tree);
    const result = await fn({ kitRoot, tmpDir, core });
    if (options.persist) {
      const mutated = await readTreeFromDir(kitRoot);
      await store.putKitTree(userId, kitId, mutated);
    }
    return result;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Materialize an arbitrary tree (not yet persisted — e.g. an uploaded zip or a
 * rendered draft) into a temp dir, run `fn`, and clean up. Used when there is no
 * KitStore kit yet.
 */
export async function withEphemeralTree<T>(tree: KitTree, fn: (ctx: RunnerContext) => Promise<T>): Promise<T> {
  const core = await loadCore();
  const tmpDir = await makeTempDir();
  const kitRoot = path.join(tmpDir, "kit");
  try {
    await writeTreeToDir(kitRoot, tree);
    return await fn({ kitRoot, tmpDir, core });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/** Materialize a temp dir with no initial tree (for create-into flows). */
export async function withTempDir<T>(fn: (tmpDir: string, core: Awaited<ReturnType<typeof loadCore>>) => Promise<T>): Promise<T> {
  const core = await loadCore();
  const tmpDir = await makeTempDir();
  try {
    return await fn(tmpDir, core);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
