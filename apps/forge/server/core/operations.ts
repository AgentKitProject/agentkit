// High-level kit operations that compose the runner with @agentkitforge/core.
// These port the LOGIC of the desktop .mjs bridge scripts into in-process calls
// (no subprocess spawn). API routes call these.
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadCore } from "@/server/core/load-core";
import { readTreeFromDir, withEphemeralTree, withMaterializedKit } from "@/server/core/runner";
import { getKitStore } from "@/server/store/local-disk";
import type { KitTree } from "@/server/store/types";

// --- validation gate ---------------------------------------------------------

/**
 * Thrown when an uploaded/imported kit fails the local-valid profile.
 * Callers map this to HTTP 422.
 */
export class KitValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(issues[0] ?? "Kit did not pass local-valid validation.");
    this.name = "KitValidationError";
    this.issues = issues;
  }
}

/**
 * Materialize `tree` into a temp dir and run `validateAgentKit` at the
 * `local-valid` profile. Throws `KitValidationError` if validation fails.
 * Use this for import flows ONLY — not for per-file editor saves (WIP drafts
 * must be temporarily invalid).
 */
export async function assertKitValid(tree: KitTree): Promise<void> {
  await withEphemeralTree(tree, async ({ core, kitRoot }) => {
    const report = await core.validateAgentKit(kitRoot, "local-valid");
    const failed = (report as { valid?: boolean; errors?: string[] | { message?: string }[] });
    if (failed.valid === false) {
      const issues: string[] = (failed.errors ?? []).map((e: unknown) =>
        typeof e === "string" ? e : (e as { message?: string }).message ?? String(e)
      );
      throw new KitValidationError(issues.length > 0 ? issues : ["Kit did not pass local-valid validation."]);
    }
  });
}

type ValidationProfile = "local-valid" | "publishable" | "trusted" | "verified";

// --- validate ----------------------------------------------------------------
export async function validateKit(userId: string, kitId: string, profile: ValidationProfile) {
  return withMaterializedKit(userId, kitId, async ({ core, kitRoot }) => {
    return core.validateAgentKit(kitRoot, profile);
  });
}

// --- package (returns zip bytes) ---------------------------------------------
export async function packageKit(userId: string, kitId: string): Promise<{ bytes: Buffer; fileName: string }> {
  return withMaterializedKit(userId, kitId, async ({ core, kitRoot, tmpDir }) => {
    const outDir = path.join(tmpDir, "out");
    await fs.mkdir(outDir, { recursive: true });
    const meta = await readArtifactMeta(core, kitRoot);
    const fileName = core.getDefaultPackageName(meta);
    const outputPath = path.join(outDir, fileName.endsWith(".zip") ? fileName : `${fileName}.agentkit.zip`);
    const artifactPath = await core.packageAgentKit(kitRoot, outputPath);
    const bytes = await fs.readFile(artifactPath);
    return { bytes, fileName: path.basename(artifactPath) };
  });
}

// --- export onefile (returns text) -------------------------------------------
export async function exportOneFile(userId: string, kitId: string): Promise<{ text: string; fileName: string }> {
  return withMaterializedKit(userId, kitId, async ({ core, kitRoot, tmpDir }) => {
    const meta = await readArtifactMeta(core, kitRoot);
    const fileName = core.getDefaultOneFileName(meta);
    const outputPath = path.join(tmpDir, fileName);
    const filePath = await core.exportOneFile(kitRoot, outputPath);
    const text = await fs.readFile(filePath, "utf8");
    return { text, fileName: path.basename(filePath) };
  });
}

// --- export to codex (returns zip of produced folder) ------------------------
export async function exportToCodex(userId: string, kitId: string): Promise<{ bytes: Buffer; fileName: string }> {
  return withMaterializedKit(userId, kitId, async ({ core, kitRoot, tmpDir }) => {
    const destDir = path.join(tmpDir, "codex-skills");
    await fs.mkdir(destDir, { recursive: true });
    await core.exportAgentKitToCodex(kitRoot, destDir, { force: true });
    const bytes = await zipDir(destDir);
    return { bytes, fileName: "codex-skills.zip" };
  });
}

// --- export to claude-code (returns zip of produced folder) ------------------
export async function exportToClaudeCode(userId: string, kitId: string): Promise<{ bytes: Buffer; fileName: string }> {
  return withMaterializedKit(userId, kitId, async ({ core, kitRoot, tmpDir }) => {
    const destDir = path.join(tmpDir, "claude-code");
    await fs.mkdir(destDir, { recursive: true });
    await core.exportAgentKitToClaudeCode(kitRoot, destDir, { force: true });
    const bytes = await zipDir(destDir);
    return { bytes, fileName: "claude-code-export.zip" };
  });
}

// --- prepared prompts --------------------------------------------------------
export async function listPreparedPrompts(userId: string, kitId: string) {
  return withMaterializedKit(userId, kitId, async ({ core, kitRoot }) => core.listPreparedPrompts(kitRoot));
}

export async function renderPreparedPrompt(
  userId: string,
  kitId: string,
  promptId: string,
  inputValues: Record<string, unknown>
) {
  return withMaterializedKit(userId, kitId, async ({ core, kitRoot }) => {
    const prompts = await core.listPreparedPrompts(kitRoot);
    const prompt = prompts.find((p) => p.id === promptId);
    if (!prompt) throw new Error(`Prepared prompt not found: ${promptId}`);
    const report = core.validatePreparedPromptInputs(prompt, inputValues);
    if (!report.valid) {
      return { valid: false as const, report };
    }
    return { valid: true as const, result: core.renderPreparedPrompt(prompt, inputValues) };
  });
}

// --- summary / inspect / version --------------------------------------------
export async function getKitSummary(userId: string, kitId: string) {
  return withMaterializedKit(userId, kitId, async ({ core, kitRoot }) => core.getAgentKitSummary(kitRoot));
}

export async function nextKitVersion(userId: string, kitId: string) {
  return withMaterializedKit(userId, kitId, async ({ core, kitRoot }) => core.nextAgentKitVersion(kitRoot));
}

// --- draft: load existing kit as draft ---------------------------------------
export async function loadKitAsDraft(userId: string, kitId: string) {
  return withMaterializedKit(userId, kitId, async ({ core, kitRoot }) => core.loadAgentKitAsDraft(kitRoot));
}

// --- draft: render a draft JSON into a NEW kit -------------------------------
// Renders the draft into a temp dir, captures the tree, then creates a kit.
export async function createKitFromDraft(userId: string, draftJson: unknown) {
  const core = await loadCore();
  const draft = core.agentKitDraftSchema.parse(draftJson);
  const tree = await withEphemeralTree({ files: [] }, async ({ tmpDir }) => {
    const outFolder = path.join(tmpDir, "rendered");
    await fs.mkdir(outFolder, { recursive: true });
    const result = await core.renderAgentKitDraft(draft, outFolder, { force: true });
    const renderedRoot = (result as { rootPath?: string }).rootPath ?? outFolder;
    return readTreeFromDir(renderedRoot);
  });
  // Gate: a rendered draft must be a valid kit before persisting.
  await assertKitValid(tree);
  const store = await getKitStore();
  return store.createKit(userId, { kind: "tree", tree, source: "draft" });
}

// --- import: upload .agentkit.zip -> new kit ---------------------------------
export async function importPackageZip(userId: string, zipBytes: Buffer): Promise<{ kitId: string }> {
  const tree = await unzipToTree(zipBytes);
  // Gate: reject non-kit zips (anti-free-file-store). WIP editor saves bypass this.
  await assertKitValid(tree);
  const store = await getKitStore();
  const meta = await store.createKit(userId, { kind: "tree", tree, source: "upload-zip" });
  return { kitId: meta.kitId };
}

// --- helpers -----------------------------------------------------------------
// Best-effort artifact-name metadata (id + version) from the kit manifest.
async function readArtifactMeta(
  core: Awaited<ReturnType<typeof loadCore>>,
  kitRoot: string
): Promise<{ id?: string; version?: string }> {
  try {
    const loaded = await core.readAgentKit(kitRoot);
    const manifest = (loaded as { manifest?: { id?: string; version?: string } }).manifest;
    return { id: manifest?.id, version: manifest?.version };
  } catch {
    return {};
  }
}

async function zipDir(dir: string): Promise<Buffer> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  async function add(current: string, prefix: string) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await add(abs, rel);
      } else if (entry.isFile()) {
        zip.file(rel, await fs.readFile(abs));
      }
    }
  }
  await add(dir, "");
  return zip.generateAsync({ type: "nodebuffer" });
}

export async function unzipToTree(zipBytes: Buffer): Promise<KitTree> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(zipBytes);
  const files: KitTree["files"] = [];
  const names: string[] = [];
  zip.forEach((relativePath, entry) => {
    if (!entry.dir) names.push(relativePath);
  });
  for (const name of names) {
    const entry = zip.file(name);
    if (!entry) continue;
    const buf = await entry.async("nodebuffer");
    const isText = !buf.subarray(0, 8000).includes(0);
    files.push(
      isText
        ? { path: name, content: buf.toString("utf8"), encoding: "utf8" }
        : { path: name, content: buf.toString("base64"), encoding: "base64" }
    );
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files };
}
