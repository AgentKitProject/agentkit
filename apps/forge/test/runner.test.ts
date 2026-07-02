import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getKitStore } from "@/server/store/local-disk";
import { packageKit, validateKit } from "@/server/core/operations";

// End-to-end core-runner round-trip: create-from-template -> validate ->
// package. Proves the materialize -> core -> cleanup path works against the
// published @agentkitforge/core, with no running server.
let dataDir: string;
const USER = "user_runner_test";

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "akf-runner-test-"));
  process.env.AGENTKITFORGE_WEB_DATA_DIR = dataDir;
});

afterAll(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("core runner round-trip", () => {
  it("creates a template kit, validates it, and packages zip bytes", async () => {
    const store = await getKitStore();
    const meta = await store.createKit(USER, {
      kind: "template",
      template: "blank",
      id: "demo-kit",
      name: "Demo Kit",
      description: "A demo kit for the runner round-trip test."
    });

    // Template tree should include the required spec files.
    const tree = await store.getKitTree(USER, meta.kitId);
    const paths = tree.files.map((f) => f.path);
    expect(paths).toContain("agentkit.yaml");

    // Validate against the local-valid profile.
    const report = await validateKit(USER, meta.kitId, "local-valid");
    expect(report).toBeTruthy();
    expect(typeof (report as { ok?: boolean }).ok === "boolean" || Array.isArray((report as { issues?: unknown[] }).issues)).toBe(
      true
    );

    // Package -> real zip bytes.
    const { bytes, fileName } = await packageKit(USER, meta.kitId);
    expect(bytes.length).toBeGreaterThan(0);
    // ZIP magic number "PK".
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(fileName.endsWith(".zip")).toBe(true);

    await store.deleteKit(USER, meta.kitId);
  }, 60_000);
});
