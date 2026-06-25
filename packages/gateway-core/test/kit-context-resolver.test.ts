/**
 * Seam #1 — server-side kit-context resolver from object storage.
 *
 * Test-mode: an in-memory fake KitPackageStore (no real S3). Covers prompt
 * assembly (AGENTKIT.md + START_HERE.md + skills), base64 decoding, tool
 * extraction from tools.json, the default-prompt fallback on a missing package,
 * and that the managed-server composition wires these resolvers so a managed
 * turn's request carries the kit's prompt + tools.
 */

import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import {
  assembleSystemPrompt,
  extractTools,
  makeObjectStorageKitResolvers,
  serializeKitPackage,
  DEFAULT_SYSTEM_PROMPT,
  type KitPackageStore,
  type KitPackageTree,
  type KitPackageWriter,
} from "../src/core/services/kit-context-resolver.js";
import {
  composeManagedGateway,
  type SchemaApplyPool,
} from "../src/entrypoints/managed-server.js";
import type { ChatProvider } from "../src/core/ports.js";
import type { ChatRequest, ChatResponse, GatewaySession } from "../src/core/types.js";

function session(systemPromptRef: string): GatewaySession {
  return {
    sessionId: "s1",
    userId: "u1",
    kitId: "kit-1",
    kitSlug: "kit-1",
    systemPromptRef,
    billingMode: "managed",
    byoProviderConfig: null,
    messages: [],
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
    expiresAt: 9_999_999_999,
  };
}

class FakeKitStore implements KitPackageStore {
  constructor(private readonly map: Map<string, KitPackageTree>) {}
  async getKitPackage(key: string): Promise<KitPackageTree | undefined> {
    return this.map.get(key);
  }
}

/**
 * In-memory object store implementing BOTH the reader and writer ports, going
 * through `serializeKitPackage` on write + JSON.parse on read — so it exercises
 * the exact on-storage layout an S3 round-trip would (no real S3). `puts` counts
 * writes to assert idempotent re-stage / "BYO does not stage".
 */
class FakeObjectStore implements KitPackageStore, KitPackageWriter {
  readonly blobs = new Map<string, string>();
  puts = 0;
  async putKitPackage(key: string, tree: KitPackageTree): Promise<void> {
    this.puts += 1;
    this.blobs.set(key, serializeKitPackage(tree));
  }
  async getKitPackage(key: string): Promise<KitPackageTree | undefined> {
    const blob = this.blobs.get(key);
    if (blob === undefined) return undefined;
    const parsed = JSON.parse(blob) as Partial<KitPackageTree>;
    return { files: Array.isArray(parsed.files) ? parsed.files : [] };
  }
}

describe("assembleSystemPrompt", () => {
  it("concatenates AGENTKIT.md + START_HERE.md then skills, in order", () => {
    const tree: KitPackageTree = {
      files: [
        { path: "START_HERE.md", content: "start here" },
        { path: "AGENTKIT.md", content: "agent kit" },
        { path: "skills/b/SKILL.md", content: "skill b" },
        { path: "skills/a/SKILL.md", content: "skill a" },
        { path: "README.md", content: "ignored" },
      ],
    };
    expect(assembleSystemPrompt(tree)).toBe("agent kit\n\nstart here\n\nskill a\n\nskill b");
  });

  it("decodes base64-encoded files", () => {
    const tree: KitPackageTree = {
      files: [
        { path: "AGENTKIT.md", content: Buffer.from("hello").toString("base64"), encoding: "base64" },
      ],
    };
    expect(assembleSystemPrompt(tree)).toBe("hello");
  });

  it("falls back to the default prompt when there are no instruction files", () => {
    expect(assembleSystemPrompt({ files: [{ path: "x.txt", content: "nope" }] })).toBe(
      DEFAULT_SYSTEM_PROMPT,
    );
  });
});

describe("extractTools", () => {
  it("parses tools.json into ToolDefinitions", () => {
    const tree: KitPackageTree = {
      files: [
        {
          path: "tools.json",
          content: JSON.stringify([
            { name: "read_file", description: "reads", inputSchema: { type: "object" } },
            { name: "noschema" },
            { notAName: true },
          ]),
        },
      ],
    };
    const tools = extractTools(tree);
    expect(tools.map((t) => t.name)).toEqual(["read_file", "noschema"]);
    expect(tools[0]).toEqual({ name: "read_file", description: "reads", inputSchema: { type: "object" } });
  });

  it("returns no tools when tools.json is absent or malformed", () => {
    expect(extractTools({ files: [] })).toEqual([]);
    expect(extractTools({ files: [{ path: "tools.json", content: "not json" }] })).toEqual([]);
  });
});

describe("serializeKitPackage", () => {
  it("emits the reader's layout with files sorted by path and encoding defaulted", () => {
    const blob = serializeKitPackage({
      files: [
        { path: "START_HERE.md", content: "b" },
        { path: "AGENTKIT.md", content: "a" },
      ],
    });
    expect(JSON.parse(blob)).toEqual({
      files: [
        { path: "AGENTKIT.md", content: "a", encoding: "utf8" },
        { path: "START_HERE.md", content: "b", encoding: "utf8" },
      ],
    });
  });

  it("is deterministic regardless of input file order (idempotent bytes)", () => {
    const a = serializeKitPackage({
      files: [
        { path: "skills/b/SKILL.md", content: "B" },
        { path: "skills/a/SKILL.md", content: "A" },
      ],
    });
    const b = serializeKitPackage({
      files: [
        { path: "skills/a/SKILL.md", content: "A" },
        { path: "skills/b/SKILL.md", content: "B" },
      ],
    });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Staging WRITER ↔ reader round-trip (the missing managed-run half).
// ---------------------------------------------------------------------------

describe("KitPackageWriter ↔ reader round-trip", () => {
  const REF = "auto-kits/run-123/package.json";
  const pkg: KitPackageTree = {
    files: [
      { path: "AGENTKIT.md", content: "you are the kit" },
      { path: "START_HERE.md", content: "start here" },
      { path: "skills/research/SKILL.md", content: "do research" },
      { path: "tools.json", content: JSON.stringify([{ name: "read_file" }, { name: "list_dir" }]) },
    ],
  };

  it("a staged package is read back to the same assembled prompt + tools", async () => {
    const store = new FakeObjectStore();
    await store.putKitPackage(REF, pkg);

    // Read back via the SAME resolvers a managed turn uses.
    const resolvers = makeObjectStorageKitResolvers(store);
    const s = session(REF);
    expect(await resolvers.resolveSystemPrompt(s)).toBe(
      "you are the kit\n\nstart here\n\ndo research",
    );
    expect((await resolvers.resolveTools(s)).map((t) => t.name)).toEqual(["read_file", "list_dir"]);
  });

  it("re-staging the same key is idempotent (same bytes, overwrite)", async () => {
    const store = new FakeObjectStore();
    await store.putKitPackage(REF, pkg);
    const first = store.blobs.get(REF);
    await store.putKitPackage(REF, pkg);
    expect(store.puts).toBe(2);
    expect(store.blobs.get(REF)).toBe(first);
    // Still resolves to the same thing after the re-stage.
    const resolvers = makeObjectStorageKitResolvers(store);
    expect((await resolvers.resolveTools(session(REF))).map((t) => t.name)).toEqual([
      "read_file",
      "list_dir",
    ]);
  });

  it("the writer preserves base64-encoded files for the reader to decode", async () => {
    const store = new FakeObjectStore();
    await store.putKitPackage("k", {
      files: [
        {
          path: "AGENTKIT.md",
          content: Buffer.from("encoded prompt").toString("base64"),
          encoding: "base64",
        },
      ],
    });
    const resolvers = makeObjectStorageKitResolvers(store);
    expect(await resolvers.resolveSystemPrompt(session("k"))).toBe("encoded prompt");
  });
});

describe("makeObjectStorageKitResolvers", () => {
  it("resolves prompt + tools from the store by systemPromptRef", async () => {
    const store = new FakeKitStore(
      new Map([
        [
          "kits/u1/kit-1.json",
          {
            files: [
              { path: "AGENTKIT.md", content: "be helpful" },
              { path: "tools.json", content: JSON.stringify([{ name: "list_dir" }]) },
            ],
          },
        ],
      ]),
    );
    const resolvers = makeObjectStorageKitResolvers(store);
    const s = session("kits/u1/kit-1.json");
    expect(await resolvers.resolveSystemPrompt(s)).toBe("be helpful");
    expect((await resolvers.resolveTools(s)).map((t) => t.name)).toEqual(["list_dir"]);
  });

  it("degrades to defaults on a missing package (no throw)", async () => {
    const resolvers = makeObjectStorageKitResolvers(new FakeKitStore(new Map()));
    const s = session("absent");
    expect(await resolvers.resolveSystemPrompt(s)).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(await resolvers.resolveTools(s)).toEqual([]);
  });

  it("degrades to defaults when the store throws (never surfaces the key)", async () => {
    const throwing: KitPackageStore = {
      async getKitPackage() {
        throw new Error("S3 AccessDenied");
      },
    };
    const resolvers = makeObjectStorageKitResolvers(throwing);
    const s = session("any");
    expect(await resolvers.resolveSystemPrompt(s)).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(await resolvers.resolveTools(s)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Composition wiring: the resolvers reach the streaming-turn deps.
// ---------------------------------------------------------------------------

function freshPool(): SchemaApplyPool {
  const db = newDb();
  db.public.registerFunction({
    name: "pg_advisory_lock",
    args: ["integer" as never],
    returns: "bool" as never,
    implementation: () => true,
  } as never);
  db.public.registerFunction({
    name: "pg_advisory_unlock",
    args: ["integer" as never],
    returns: "bool" as never,
    implementation: () => true,
  } as never);
  const { Pool } = db.adapters.createPg();
  return new Pool() as unknown as SchemaApplyPool;
}

class FakeProvider implements ChatProvider {
  readonly providerType = "fake";
  async sendMessage(_request: ChatRequest): Promise<ChatResponse> {
    return {
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cachedReadTokens: 0, cachedWriteTokens: 0 },
    };
  }
  async streamMessage(): Promise<ChatResponse> {
    throw new Error("not used");
  }
}

describe("composeManagedGateway wires the object-storage resolvers (seam #1)", () => {
  it("turn deps resolveSystemPrompt/resolveTools read from the injected store", async () => {
    const store = new FakeKitStore(
      new Map([
        [
          "ref-1",
          {
            files: [
              { path: "AGENTKIT.md", content: "kit prompt" },
              { path: "tools.json", content: JSON.stringify([{ name: "write_file" }]) },
            ],
          },
        ],
      ]),
    );
    const composed = await composeManagedGateway({
      pool: freshPool(),
      chatProvider: new FakeProvider(),
      now: () => "2026-06-25T00:00:00.000Z",
      kitPackageStore: store,
      commercialImporter: async () => {
        throw new Error("absent");
      },
    });

    const s = session("ref-1");
    expect(await composed.routerDeps.turn.resolveSystemPrompt(s)).toBe("kit prompt");
    expect((await composed.routerDeps.turn.resolveTools!(s)).map((t) => t.name)).toEqual([
      "write_file",
    ]);
  });

  it("explicit resolvers override the store; default model/maxTokens applied (seam #3)", async () => {
    const composed = await composeManagedGateway({
      pool: freshPool(),
      chatProvider: new FakeProvider(),
      now: () => "2026-06-25T00:00:00.000Z",
      resolveSystemPrompt: async () => "explicit",
      commercialImporter: async () => {
        throw new Error("absent");
      },
    });
    expect(await composed.routerDeps.turn.resolveSystemPrompt(session("ref-1"))).toBe("explicit");
    // Seam #3: default model + maxTokens come from the config constants.
    expect(composed.routerDeps.turn.model).toBe("claude-sonnet-4-6");
    expect(composed.routerDeps.turn.maxTokens).toBe(4096);
  });

  it("model/maxTokens are driven by options when supplied (seam #3)", async () => {
    const composed = await composeManagedGateway({
      pool: freshPool(),
      chatProvider: new FakeProvider(),
      now: () => "2026-06-25T00:00:00.000Z",
      model: "claude-opus-4-8",
      maxTokens: 8192,
      commercialImporter: async () => {
        throw new Error("absent");
      },
    });
    expect(composed.routerDeps.turn.model).toBe("claude-opus-4-8");
    expect(composed.routerDeps.turn.maxTokens).toBe(8192);
  });
});
