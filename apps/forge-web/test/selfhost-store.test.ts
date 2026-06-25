// Self-host adapter tests: real in-memory Postgres via pg-mem (proves the
// idempotent schema + SQL), and an injected in-memory S3 fake for the MinIO
// tree storage. Mirrors the Market self-host test approach.
import { describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import { SelfHostKitStore } from "@/server/store/selfhost-kit-store";
import { SelfHostUserSettingsStore } from "@/server/store/selfhost-user-settings";
import { __resetEnsured, type PgPool } from "@/server/store/selfhost-pg";

class FakeS3 {
  objects = new Map<string, Buffer>();
  async send(cmd: any): Promise<any> {
    const c = cmd.constructor.name;
    const input = cmd.input;
    if (c === "HeadBucketCommand") return {};
    if (c === "CreateBucketCommand") return {};
    const key = `${input.Bucket}/${input.Key}`;
    if (c === "PutObjectCommand") {
      this.objects.set(key, Buffer.from(input.Body));
      return {};
    }
    if (c === "GetObjectCommand") {
      const buf = this.objects.get(key);
      if (!buf) {
        const err: any = new Error("not found");
        err.name = "NoSuchKey";
        throw err;
      }
      return { Body: { transformToByteArray: async () => new Uint8Array(buf) } };
    }
    if (c === "DeleteObjectCommand") {
      this.objects.delete(key);
      return {};
    }
    throw new Error(`unhandled ${c}`);
  }
}

function makePool(): PgPool {
  const db = newDb();
  const pg = db.adapters.createPg();
  __resetEnsured();
  return new pg.Pool() as unknown as PgPool;
}

const cfg = {
  s3Endpoint: "http://minio:9000",
  s3Bucket: "kits",
  s3AccessKeyId: "k",
  s3SecretAccessKey: "s",
  ensureBucket: true
};

const USER = "user_sh_1";

describe("SelfHostKitStore (pg-mem + fake MinIO)", () => {
  it("creates, reads, mutates, lists and deletes a kit", async () => {
    const pool = makePool();
    const s3 = new FakeS3();
    const store = new SelfHostKitStore(pool, cfg, { s3: s3 as any });

    const meta = await store.createKit(USER, {
      kind: "tree",
      source: "upload-zip",
      tree: { files: [{ path: "agentkit.yaml", content: "name: Demo\n", encoding: "utf8" }] }
    });
    expect(meta.name).toBe("Demo");
    expect([...s3.objects.keys()][0]).toBe(`kits/kits/${USER}/${meta.kitId}/tree.json`);

    await store.writeKitFile(USER, meta.kitId, { path: "skills/x/SKILL.md", content: "# x" });
    const tree = await store.getKitTree(USER, meta.kitId);
    expect(tree.files.some((f) => f.path === "skills/x/SKILL.md")).toBe(true);

    const list = await store.listUserKits(USER);
    expect(list).toHaveLength(1);

    await store.deleteKit(USER, meta.kitId);
    expect(await store.getKitMetadata(USER, meta.kitId)).toBeNull();
    expect(s3.objects.size).toBe(0);
  });

  it("rejects path traversal", async () => {
    const store = new SelfHostKitStore(makePool(), cfg, { s3: new FakeS3() as any });
    const meta = await store.createKit(USER, {
      kind: "tree",
      source: "upload-zip",
      tree: { files: [{ path: "agentkit.yaml", content: "name: D\n" }] }
    });
    await expect(store.writeKitFile(USER, meta.kitId, { path: "../x", content: "x" })).rejects.toThrow();
  });
});

describe("SelfHostKitStore S3 forcePathStyle", () => {
  async function resolveForcePathStyle(store: SelfHostKitStore): Promise<boolean> {
    const s3 = (store as any).s3;
    const v = s3.config.forcePathStyle;
    return typeof v === "function" ? await v() : v;
  }

  it("defaults forcePathStyle to true (MinIO/self-host)", async () => {
    const store = new SelfHostKitStore(makePool(), cfg);
    expect(await resolveForcePathStyle(store)).toBe(true);
  });

  it("honors s3ForcePathStyle=false (real AWS S3)", async () => {
    const store = new SelfHostKitStore(makePool(), { ...cfg, s3ForcePathStyle: false });
    expect(await resolveForcePathStyle(store)).toBe(false);
  });
});

describe("SelfHostUserSettingsStore (pg-mem)", () => {
  it("encrypts at rest and never returns the key", async () => {
    process.env.AGENTKITFORGE_WEB_SECRET = "b".repeat(64);
    const store = new SelfHostUserSettingsStore(makePool());
    const saved = await store.saveProvider(USER, { name: "OpenAI", providerType: "openai", apiKey: "sk-x" });
    expect(saved.hasApiKey).toBe(true);
    expect((saved as any).apiKey).toBeUndefined();
    const resolved = await store.resolveProvider(USER);
    expect(resolved?.apiKey).toBe("sk-x");
    const pub = await store.getPublic(USER);
    expect((pub.providers[0] as any).apiKey).toBeUndefined();
  });
});
