/**
 * Folder-watch wizard step + inline-connect pure logic (lib/automations/
 * watch-connect.ts): the S3 inline-create request shape (must match auto-core's
 * parseS3ConnectionSecret exactly + carry NO secret material in `config`), the
 * watch trigger config the wizard submits, and the OAuth draft persist/restore
 * that survives the gdrive/dropbox full-page redirect.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConnectionRequestSchema,
  createTriggerRequestSchema,
  watchTriggerConfigSchema
} from "@agentkitforge/contracts";
import { parseS3ConnectionSecret } from "@agentkitforge/auto-core";
import {
  buildS3ConnectionRequest,
  buildTriggerMapping,
  buildWatchConfig,
  encodeS3ConnectionSecret,
  isWatchableConnectionType,
  saveWatchDraft,
  takeWatchDraft,
  validateS3ConnectFields,
  WATCH_DRAFT_STORAGE_KEY,
  type WatchWizardDraft
} from "@/lib/automations/watch-connect";
import { createTrigger } from "@/lib/automations/client";

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("watchable connection types", () => {
  it("is exactly the three folder-storage types", () => {
    expect(isWatchableConnectionType("s3")).toBe(true);
    expect(isWatchableConnectionType("gdrive")).toBe(true);
    expect(isWatchableConnectionType("dropbox")).toBe(true);
    // Delivery-only / bot types are not watchable.
    expect(isWatchableConnectionType("slack_incoming")).toBe(false);
    expect(isWatchableConnectionType("webhook_out")).toBe(false);
    expect(isWatchableConnectionType("email")).toBe(false);
  });
});

describe("S3 inline connection create", () => {
  it("encodes the secret in the EXACT format parseS3ConnectionSecret round-trips", () => {
    const secret = encodeS3ConnectionSecret("AKIA123", "sk/with:colons+slashes");
    // parseS3ConnectionSecret is auto-core's server-side reader — the wizard's
    // secret must decode back to the same credentials it was given.
    expect(parseS3ConnectionSecret(secret)).toEqual({
      accessKeyId: "AKIA123",
      secretAccessKey: "sk/with:colons+slashes"
    });
  });

  it("builds a contract-valid s3 create request; credentials ride in `secret`, never in config", () => {
    const req = buildS3ConnectionRequest({
      name: "  Inbox bucket  ",
      bucket: " my-bucket ",
      region: " us-east-1 ",
      endpoint: " https://nyc3.digitaloceanspaces.com ",
      accessKeyId: " AKIA ",
      secretAccessKey: " shh "
    });
    // The contract (which REFINES config to reject secret-looking keys) accepts it.
    const parsed = createConnectionRequestSchema.safeParse(req);
    expect(parsed.success).toBe(true);
    expect(req.type).toBe("s3");
    expect(req.name).toBe("Inbox bucket");
    // Non-secret config only; endpoint present → path-style addressing.
    expect(req.config).toEqual({
      bucket: "my-bucket",
      region: "us-east-1",
      endpoint: "https://nyc3.digitaloceanspaces.com",
      forcePathStyle: true
    });
    // S2: the credentials are in the write-only secret, decodable server-side.
    expect(parseS3ConnectionSecret(req.secret!)).toEqual({ accessKeyId: "AKIA", secretAccessKey: "shh" });
  });

  it("omits region/endpoint when blank (no forcePathStyle without an endpoint)", () => {
    const req = buildS3ConnectionRequest({
      name: "b",
      bucket: "bucket",
      region: "",
      endpoint: "",
      accessKeyId: "id",
      secretAccessKey: "key"
    });
    expect(req.config).toEqual({ bucket: "bucket" });
  });

  it("validateS3ConnectFields flags each missing required field, else null", () => {
    const base = { name: "n", bucket: "b", accessKeyId: "id", secretAccessKey: "key" };
    expect(validateS3ConnectFields(base)).toBeNull();
    expect(validateS3ConnectFields({ ...base, name: " " })).toMatch(/name/i);
    expect(validateS3ConnectFields({ ...base, bucket: "" })).toMatch(/bucket/i);
    expect(validateS3ConnectFields({ ...base, accessKeyId: "" })).toMatch(/access key id/i);
    expect(validateS3ConnectFields({ ...base, secretAccessKey: "" })).toMatch(/secret access key/i);
  });
});

describe("watch trigger config", () => {
  it("builds a contract-valid watch config (blank pattern omitted; interval clamped)", () => {
    const cfg = buildWatchConfig({
      connectionId: "c1",
      prefix: " inbox/ ",
      pattern: " ",
      batchMode: "per_batch",
      intervalMinutes: 0, // below min → clamped to a sane default
      includeExisting: true
    });
    expect(watchTriggerConfigSchema.safeParse(cfg).success).toBe(true);
    expect(cfg).toEqual({
      connectionId: "c1",
      prefix: "inbox/",
      batchMode: "per_batch",
      intervalMinutes: 5,
      includeExisting: true
    });
    expect("pattern" in cfg).toBe(false);

    const withPattern = buildWatchConfig({
      connectionId: "c1",
      prefix: "",
      pattern: "*.csv",
      batchMode: "per_file",
      intervalMinutes: 9999, // above max → clamped to 1440
      includeExisting: false
    });
    expect(withPattern.pattern).toBe("*.csv");
    expect(withPattern.intervalMinutes).toBe(1440);
  });

  it("a full watch create request (config + mapping) passes the create-trigger contract", async () => {
    const fn = mockFetch(200, { id: "t-watch", type: "watch" });
    const req = {
      name: "CSV intake",
      type: "watch" as const,
      kitRef: { source: "local" as const, localKitId: "kit1" },
      approvalId: "appr1",
      mapping: buildTriggerMapping("Summarize {{name}}", true),
      config: buildWatchConfig({
        connectionId: "c1",
        prefix: "inbox/",
        pattern: "*.csv",
        batchMode: "per_file",
        intervalMinutes: 5,
        includeExisting: false
      }),
      enabled: true
    };
    expect(createTriggerRequestSchema.safeParse(req).success).toBe(true);
    await createTrigger(req);
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auto/triggers");
    const sent = JSON.parse(String(init.body));
    expect(sent.type).toBe("watch");
    expect(sent.config.connectionId).toBe("c1");
  });
});

describe("OAuth draft persist/restore (survives the full-page redirect)", () => {
  function memStore() {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      _map: map
    };
  }

  const draft: WatchWizardDraft = {
    version: 1,
    name: "Drive intake",
    prefix: "reports/",
    pattern: "*.pdf",
    batchMode: "per_batch",
    intervalMinutes: 10,
    includeExisting: true
  };

  it("save then take round-trips the draft and clears it (one-shot)", () => {
    const store = memStore();
    saveWatchDraft(draft, store);
    expect(store._map.has(WATCH_DRAFT_STORAGE_KEY)).toBe(true);
    expect(takeWatchDraft(store)).toEqual(draft);
    // One-shot: the key is removed on take, so a second restore finds nothing.
    expect(store._map.has(WATCH_DRAFT_STORAGE_KEY)).toBe(false);
    expect(takeWatchDraft(store)).toBeNull();
  });

  it("take returns null for absent or malformed drafts", () => {
    const store = memStore();
    expect(takeWatchDraft(store)).toBeNull();
    store.setItem(WATCH_DRAFT_STORAGE_KEY, "not json{");
    expect(takeWatchDraft(store)).toBeNull();
    store.setItem(WATCH_DRAFT_STORAGE_KEY, JSON.stringify({ version: 2, name: "x" }));
    expect(takeWatchDraft(store)).toBeNull();
  });
});
