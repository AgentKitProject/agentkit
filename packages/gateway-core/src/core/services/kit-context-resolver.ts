/**
 * Server-side kit-context resolver (managed gateway seam #1).
 *
 * A managed gateway session injects a SECRET system prompt + the kit's declared
 * tools into every provider round-trip. In the HOSTED deployment the gateway
 * image has no local KitStore (that lives in the Next.js app); instead the kit
 * package is staged in OBJECT STORAGE (AWS S3 / DO Spaces — the same S3 client
 * the apps use). The session's `systemPromptRef` is the object key for that
 * package. This module reads the package server-side and assembles the prompt +
 * tools, so a managed run actually has its kit context.
 *
 * SECURITY (Tier-3 invariant): the resolved prompt + tools are placed in the
 * ChatRequest and NEVER emitted to the client. This module only READS object
 * storage; it never logs the prompt or the package bytes.
 *
 * Open-core discipline: the object-storage backend is an injected PORT
 * (`KitPackageStore`), so tests use an in-memory fake and the package keeps NO
 * hard S3 dependency at import time (the S3 adapter lazy-imports
 * `@aws-sdk/client-s3`). This mirrors the auto-core S3InputStore pattern.
 */

import type { GatewaySession, ToolDefinition } from "../types.js";

// ---------------------------------------------------------------------------
// Kit package shape (object storage)
// ---------------------------------------------------------------------------

/** One file in a stored kit package tree. */
export interface KitPackageFile {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

/** A stored kit package: a flat file tree (the same JSON blob shape the apps'
 *  KitStore adapters persist via serializeTree/deserializeTree). */
export interface KitPackageTree {
  files: KitPackageFile[];
}

/**
 * Reads a kit package tree from object storage by its key. Implementations:
 *   - `S3KitPackageStore` (hosted: AWS S3 / DO Spaces),
 *   - an in-memory fake (tests).
 * Returns undefined when the key is absent.
 */
export interface KitPackageStore {
  getKitPackage(key: string): Promise<KitPackageTree | undefined>;
}

/**
 * WRITER counterpart of {@link KitPackageStore}: STAGES a kit package tree into
 * object storage at `key`, in the EXACT layout {@link KitPackageStore} reads
 * back (a single JSON blob `{ files: [...] }`). A managed run stages its kit
 * package before dispatch so the gateway/worker can resolve the secret system
 * prompt + tools server-side via the reader. Implementations:
 *   - `S3KitPackageStore` (hosted: AWS S3 / DO Spaces — same client as the reader),
 *   - an in-memory fake (tests).
 *
 * `putKitPackage` is idempotent: staging the same key twice overwrites with the
 * same bytes (object storage PUT semantics), so a re-dispatched run is safe.
 */
export interface KitPackageWriter {
  putKitPackage(key: string, tree: KitPackageTree): Promise<void>;
}

/**
 * Serializes a kit package tree to the canonical on-storage JSON the reader
 * (`S3KitPackageStore.getKitPackage` / `makeObjectStorageKitResolvers`) parses:
 * `{ files: [{ path, content, encoding }] }`. Files are sorted by path so the
 * same logical package always produces byte-identical output (deterministic,
 * idempotent re-stage). Each file's `encoding` defaults to "utf8".
 *
 * This is the single source of truth for the stored layout — the writer adapter
 * and the in-memory test fake both go through it so the writer can NEVER drift
 * from the shape the reader expects.
 */
export function serializeKitPackage(tree: KitPackageTree): string {
  const files = tree.files
    .map((f) => ({
      path: f.path,
      content: f.content,
      encoding: f.encoding ?? "utf8",
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return JSON.stringify({ files });
}

// ---------------------------------------------------------------------------
// Prompt + tool assembly
// ---------------------------------------------------------------------------

/** Default prompt when a package has no usable instruction files. */
export const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant running an Agent Kit.";

/** The instruction files (in priority order) assembled into the system prompt.
 *  Mirrors the spec's required-file set (AGENTKIT.md + START_HERE.md). */
const PROMPT_FILES = ["AGENTKIT.md", "START_HERE.md"] as const;

/** Decodes a package file's content to UTF-8 text (handles base64-encoded files). */
function fileText(file: KitPackageFile): string {
  if (file.encoding === "base64") {
    return Buffer.from(file.content, "base64").toString("utf8");
  }
  return file.content;
}

/**
 * Assembles the system prompt from a kit package: concatenates AGENTKIT.md +
 * START_HERE.md (in that order, when present), then appends each skill's
 * SKILL.md. Falls back to DEFAULT_SYSTEM_PROMPT when no instruction files exist.
 */
export function assembleSystemPrompt(tree: KitPackageTree): string {
  const byPath = new Map(tree.files.map((f) => [f.path, f] as const));
  const parts: string[] = [];

  for (const name of PROMPT_FILES) {
    const file = byPath.get(name);
    if (file) {
      const text = fileText(file).trim();
      if (text.length > 0) parts.push(text);
    }
  }

  // Append skill instructions (skills/<name>/SKILL.md), sorted for determinism.
  const skillFiles = tree.files
    .filter((f) => /^skills\/[^/]+\/SKILL\.md$/.test(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const file of skillFiles) {
    const text = fileText(file).trim();
    if (text.length > 0) parts.push(text);
  }

  const assembled = parts.join("\n\n").trim();
  return assembled.length > 0 ? assembled : DEFAULT_SYSTEM_PROMPT;
}

/**
 * Extracts the kit's declared tools from the package. Tools are declared in an
 * optional `tools.json` at the package root as an array of ToolDefinition (the
 * Anthropic tool-definition shape). Absent / malformed → no tools.
 */
export function extractTools(tree: KitPackageTree): ToolDefinition[] {
  const file = tree.files.find((f) => f.path === "tools.json");
  if (!file) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText(file));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const tools: ToolDefinition[] = [];
  for (const entry of parsed) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as Record<string, unknown>).name === "string"
    ) {
      const e = entry as Record<string, unknown>;
      tools.push({
        name: e.name as string,
        description: typeof e.description === "string" ? e.description : "",
        inputSchema:
          e.inputSchema && typeof e.inputSchema === "object"
            ? (e.inputSchema as Record<string, unknown>)
            : { type: "object" },
      });
    }
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Resolver factory (the seam the composition root injects)
// ---------------------------------------------------------------------------

/** The pair of session-resolver hooks the streaming/managed turn deps need. */
export interface KitContextResolvers {
  resolveSystemPrompt: (session: GatewaySession) => Promise<string>;
  resolveTools: (session: GatewaySession) => Promise<ToolDefinition[]>;
}

/**
 * Builds the `resolveSystemPrompt` + `resolveTools` hooks backed by a
 * {@link KitPackageStore}. Each hook reads the kit package keyed by the
 * session's `systemPromptRef`, then assembles the prompt / extracts tools.
 *
 * A missing / unreadable package degrades to the default prompt + no tools
 * (the run still proceeds rather than hard-failing on an object-store miss);
 * the store error is swallowed here and never surfaces the key or bytes.
 */
export function makeObjectStorageKitResolvers(store: KitPackageStore): KitContextResolvers {
  const load = async (session: GatewaySession): Promise<KitPackageTree | undefined> => {
    const key = session.systemPromptRef;
    if (!key || key.trim() === "") return undefined;
    try {
      return await store.getKitPackage(key);
    } catch {
      // Never surface the key/bytes; degrade to defaults.
      return undefined;
    }
  };

  return {
    resolveSystemPrompt: async (session) => {
      const tree = await load(session);
      return tree ? assembleSystemPrompt(tree) : DEFAULT_SYSTEM_PROMPT;
    },
    resolveTools: async (session) => {
      const tree = await load(session);
      return tree ? extractTools(tree) : [];
    },
  };
}
