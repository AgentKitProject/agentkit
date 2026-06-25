// Managed-run kit-package STAGING writer (server/core/auto.ts
// stageManagedKitPackage) — the missing half of managed Auto runs.
//
// Test-mode only: a local KitStore-backed kit (no Market / network) over a temp
// dir, AuthKit stubbed, and @aws-sdk/client-s3 MOCKED with an in-memory object
// store (NO real S3). The captured blob is read back through gateway-core's
// reader (makeObjectStorageKitResolvers + S3KitPackageStore layout) to prove the
// stage→resolve round-trip lands the same prompt + tools. Covers:
//   - managed run stages a package; reader assembles prompt + extracts tools;
//   - re-staging the same run is idempotent (same key, same bytes);
//   - a BYO run does NOT stage;
//   - no S3 bucket configured → no-op (no stage).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewaySession } from "@agentkitforge/gateway-core";
import {
  makeObjectStorageKitResolvers,
  type KitPackageStore,
  type KitPackageTree,
} from "@agentkitforge/gateway-core/services/kit-context-resolver";

// auto.ts transitively imports AuthKit; stub so the module graph loads bare.
vi.mock("@workos-inc/authkit-nextjs", () => ({
  withAuth: vi.fn(),
  getSignInUrl: vi.fn(),
  handleAuth: vi.fn(),
  saveSession: vi.fn(),
  authkitMiddleware: vi.fn(() => vi.fn()),
}));

// In-memory object store backing the mocked S3 client. Captures every PutObject
// body keyed by the object Key, so we can read it back through the gateway-core
// reader exactly like a real S3 round-trip.
const objects = new Map<string, string>();
let putCount = 0;

vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand {
    constructor(public readonly input: { Bucket: string; Key: string; Body: string }) {}
  }
  class GetObjectCommand {
    constructor(public readonly input: { Bucket: string; Key: string }) {}
  }
  class S3Client {
    async send(cmd: PutObjectCommand | GetObjectCommand): Promise<unknown> {
      if (cmd instanceof PutObjectCommand) {
        putCount += 1;
        objects.set(cmd.input.Key, String(cmd.input.Body));
        return {};
      }
      const body = objects.get(cmd.input.Key);
      if (body === undefined) {
        const err = new Error("NoSuchKey");
        (err as { name?: string }).name = "NoSuchKey";
        throw err;
      }
      return { Body: { transformToString: async () => body } };
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand };
});

const ORIGINAL_ENV = { ...process.env };
let dataDir: string;

const USER = "user-1";
const BUCKET = "kit-packages-test";

function session(systemPromptRef: string): GatewaySession {
  return {
    sessionId: "s1",
    userId: USER,
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

// A reader over the in-memory objects, matching the S3KitPackageStore layout
// (single JSON blob `{ files: [...] }`). This is what the gateway/worker uses.
const reader: KitPackageStore = {
  async getKitPackage(key: string): Promise<KitPackageTree | undefined> {
    const blob = objects.get(key);
    if (blob === undefined) return undefined;
    const parsed = JSON.parse(blob) as Partial<KitPackageTree>;
    return { files: Array.isArray(parsed.files) ? parsed.files : [] };
  },
};

const APPROVAL = {
  id: "appr-1",
  userId: USER,
  toolAllowlist: ["read_file", "list_dir"],
} as never;

async function seedLocalKit(): Promise<string> {
  const { getKitStore } = await import("@/server/store/index");
  const store = await getKitStore();
  const meta = await store.createKit(USER, {
    kind: "tree",
    source: "draft",
    name: "Test Kit",
    tree: {
      files: [
        { path: "AGENTKIT.md", content: "you are the kit" },
        { path: "START_HERE.md", content: "start here" },
        { path: "skills/research/SKILL.md", content: "do research" },
      ],
    },
  });
  return meta.kitId;
}

function localRun(id: string, kitId: string) {
  return {
    id,
    userId: USER,
    kitRef: { source: "local" as const, localKitId: kitId },
  } as never;
}

const MANAGED = { inferenceMode: "managed" as const, isCloudRun: false, cloudRunCentsPerMin: 0 };
const BYO = { inferenceMode: "byo" as const, isCloudRun: false, cloudRunCentsPerMin: 0 };

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "auto-kit-staging-test-"));
  process.env.KITSTORE_BACKEND = "local";
  process.env.AGENTKITFORGE_WEB_DATA_DIR = dataDir;
  process.env.AGENTKITFORGE_WEB_SECRET = "b".repeat(64);
  process.env.AUTO_INPUTS_BUCKET = BUCKET;
  objects.clear();
  putCount = 0;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("stageManagedKitPackage — managed run staging writer", () => {
  it("stages a managed run's package; the reader resolves the same prompt + tools", async () => {
    const kitId = await seedLocalKit();
    const { stageManagedKitPackage, kitPackageObjectKey } = await import("@/server/core/auto");

    const run = localRun("run-1", kitId);
    const key = await stageManagedKitPackage(run, APPROVAL, MANAGED);

    expect(key).toBe(kitPackageObjectKey("run-1"));
    expect(key).toBe("auto-kits/run-1/package.json");
    expect(putCount).toBe(1);
    expect(objects.has(key!)).toBe(true);

    // Round-trip: the gateway/worker reader assembles the SAME prompt + tools.
    const resolvers = makeObjectStorageKitResolvers(reader);
    const s = session(key!);
    expect(await resolvers.resolveSystemPrompt(s)).toBe(
      "you are the kit\n\nstart here\n\ndo research",
    );
    expect((await resolvers.resolveTools(s)).map((t) => t.name)).toEqual(["read_file", "list_dir"]);
  });

  it("re-staging the same run is idempotent (same key, byte-identical body)", async () => {
    const kitId = await seedLocalKit();
    const { stageManagedKitPackage } = await import("@/server/core/auto");

    const run = localRun("run-2", kitId);
    const key1 = await stageManagedKitPackage(run, APPROVAL, MANAGED);
    const body1 = objects.get(key1!);
    const key2 = await stageManagedKitPackage(run, APPROVAL, MANAGED);

    expect(key2).toBe(key1);
    expect(putCount).toBe(2);
    expect(objects.get(key2!)).toBe(body1);
  });

  it("a BYO run does NOT stage", async () => {
    const kitId = await seedLocalKit();
    const { stageManagedKitPackage } = await import("@/server/core/auto");

    const key = await stageManagedKitPackage(localRun("run-3", kitId), APPROVAL, BYO);
    expect(key).toBeUndefined();
    expect(putCount).toBe(0);
    expect(objects.size).toBe(0);
  });

  it("no S3 bucket configured → no-op (no stage)", async () => {
    delete process.env.AUTO_INPUTS_BUCKET;
    delete process.env.S3_BUCKET;
    const kitId = await seedLocalKit();
    const { stageManagedKitPackage } = await import("@/server/core/auto");

    const key = await stageManagedKitPackage(localRun("run-4", kitId), APPROVAL, MANAGED);
    expect(key).toBeUndefined();
    expect(putCount).toBe(0);
  });
});
