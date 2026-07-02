// Materialize a kit template into an in-memory KitTree using @agentkitforge/core.
//
// Templates are rendered into an ephemeral temp dir by core, then captured as a
// KitTree so any adapter (disk, S3, MinIO) can persist them the same way. This
// is the ONE place createKit({kind:"template"}) talks to the filesystem; the
// resulting tree is backend-neutral.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCore } from "@/server/core/load-core";
import type { CreateKitFromTemplate, KitTree } from "@/server/store/types";

export async function materializeTemplateTree(input: CreateKitFromTemplate): Promise<KitTree> {
  const core = await loadCore();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "akf-tpl-"));
  try {
    const dest = path.join(tmp, "kit");
    await core.createAgentKit(dest, {
      template: input.template as Parameters<typeof core.createAgentKit>[1]["template"],
      id: input.id,
      name: input.name,
      description: input.description,
      force: true
    });
    return await readTreeFromDir(dest);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function readTreeFromDir(root: string): Promise<KitTree> {
  const files: KitTree["files"] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        const buf = await fs.readFile(abs);
        if (isProbablyText(buf)) {
          files.push({ path: rel, content: buf.toString("utf8"), encoding: "utf8" });
        } else {
          files.push({ path: rel, content: buf.toString("base64"), encoding: "base64" });
        }
      }
    }
  }
  await walk(root, "");
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files };
}

function isProbablyText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  for (const byte of sample) {
    if (byte === 0) return false;
  }
  return true;
}
