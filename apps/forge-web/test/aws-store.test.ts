// AWS adapter mapping tests. We inject in-memory fakes for the DynamoDB document
// client and the S3 client so the adapter's request/command shaping and the
// row/blob <-> record mapping are exercised without real AWS.
import { beforeEach, describe, expect, it } from "vitest";
import { AwsKitStore } from "@/server/store/aws-kit-store";
import { AwsUserSettingsStore } from "@/server/store/aws-user-settings";

// --- in-memory fakes ---------------------------------------------------------

class FakeDdb {
  // table -> key string -> item
  items = new Map<string, Record<string, any>>();
  private key(item: any): string {
    return item.kitId !== undefined ? `${item.userId}#${item.kitId}` : `${item.userId}`;
  }
  async send(cmd: any): Promise<any> {
    const c = cmd.constructor.name;
    const input = cmd.input;
    if (c === "PutCommand") {
      this.items.set(this.key(input.Item), input.Item);
      return {};
    }
    if (c === "GetCommand") {
      return { Item: this.items.get(this.key(input.Key)) };
    }
    if (c === "DeleteCommand") {
      this.items.delete(this.key(input.Key));
      return {};
    }
    if (c === "UpdateCommand") {
      const item = this.items.get(this.key(input.Key));
      if (item) item.updatedAt = input.ExpressionAttributeValues[":now"];
      return {};
    }
    if (c === "QueryCommand") {
      const u = input.ExpressionAttributeValues[":u"];
      return { Items: [...this.items.values()].filter((i) => i.userId === u) };
    }
    throw new Error(`unhandled ${c}`);
  }
}

class FakeS3 {
  objects = new Map<string, Buffer>();
  async send(cmd: any): Promise<any> {
    const c = cmd.constructor.name;
    const input = cmd.input;
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

function makeKitStore() {
  const ddb = new FakeDdb();
  const s3 = new FakeS3();
  const store = new AwsKitStore(
    { kitsTable: "kits", s3Bucket: "bucket", s3Prefix: "p/" },
    { ddb: ddb as any, s3: s3 as any }
  );
  return { store, ddb, s3 };
}

const USER = "user_aws_1";

describe("AwsKitStore (mocked S3 + DynamoDB)", () => {
  it("creates, reads, mutates, lists and deletes a kit", async () => {
    const { store, s3 } = makeKitStore();
    const meta = await store.createKit(USER, {
      kind: "tree",
      source: "upload-zip",
      tree: { files: [{ path: "agentkit.yaml", content: "name: Demo\n", encoding: "utf8" }] }
    });
    expect(meta.kitId).toBeTruthy();
    expect(meta.name).toBe("Demo");
    // tree blob written to S3 under the userId/kitId prefix.
    expect([...s3.objects.keys()][0]).toBe(`bucket/p/kits/${USER}/${meta.kitId}/tree.json`);

    const tree = await store.getKitTree(USER, meta.kitId);
    expect(tree.files.some((f) => f.path === "agentkit.yaml")).toBe(true);

    await store.writeKitFile(USER, meta.kitId, { path: "skills/x/SKILL.md", content: "# x" });
    const tree2 = await store.getKitTree(USER, meta.kitId);
    expect(tree2.files.some((f) => f.path === "skills/x/SKILL.md")).toBe(true);

    await store.deleteKitFile(USER, meta.kitId, "skills/x/SKILL.md");
    const tree3 = await store.getKitTree(USER, meta.kitId);
    expect(tree3.files.some((f) => f.path === "skills/x/SKILL.md")).toBe(false);

    const list = await store.listUserKits(USER);
    expect(list).toHaveLength(1);

    await store.deleteKit(USER, meta.kitId);
    expect(await store.getKitMetadata(USER, meta.kitId)).toBeNull();
    expect(s3.objects.size).toBe(0);
  });

  it("rejects path traversal in file paths", async () => {
    const { store } = makeKitStore();
    const meta = await store.createKit(USER, {
      kind: "tree",
      source: "upload-zip",
      tree: { files: [{ path: "agentkit.yaml", content: "name: D\n" }] }
    });
    await expect(store.writeKitFile(USER, meta.kitId, { path: "../escape", content: "x" })).rejects.toThrow();
  });

  it("favorites are vestigial no-ops", async () => {
    const { store } = makeKitStore();
    await store.addFavorite(USER, { marketSlug: "s", marketBaseUrl: "u", addedAt: "now" });
    expect(await store.listFavorites(USER)).toEqual([]);
  });
});

describe("AwsUserSettingsStore (mocked DynamoDB)", () => {
  it("round-trips providers, encrypts the key at rest, and never returns it", async () => {
    process.env.AGENTKITFORGE_WEB_SECRET = "a".repeat(64); // valid hex32
    const ddb = new FakeDdb();
    const store = new AwsUserSettingsStore({ settingsTable: "settings" }, { ddb: ddb as any });

    const saved = await store.saveProvider(USER, {
      name: "Anthropic",
      providerType: "anthropic",
      apiKey: "sk-secret"
    });
    expect((saved as any).apiKey).toBeUndefined();
    expect(saved.hasApiKey).toBe(true);

    // stored row never contains plaintext
    const row = ddb.items.get(USER)!;
    expect(JSON.stringify(row)).not.toContain("sk-secret");

    const resolved = await store.resolveProvider(USER);
    expect(resolved?.apiKey).toBe("sk-secret");

    const pub = await store.getPublic(USER);
    expect(pub.providers[0].hasApiKey).toBe(true);
    expect((pub.providers[0] as any).apiKey).toBeUndefined();
  });
});
