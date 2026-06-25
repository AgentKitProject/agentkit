import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@agentkitforge/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridge = path.join(here, "..", "src-tauri", "backend", "agent-kit-version.mjs");

function runBridge(args) {
  return spawnSync(process.execPath, [bridge, ...args], { encoding: "utf8" });
}

async function makeKit() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "akt-version-"));
  const root = path.join(dir, "kit");
  await core.createAgentKit(root, {
    template: "blank",
    id: "version-test-kit",
    name: "Version Test Kit",
    description: "Fixture kit for version bridge tests.",
  });
  return root;
}

test("agent-kit-version bridge gets the current version", async () => {
  const root = await makeKit();
  const result = runBridge(["get", root]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(typeof parsed.version, "string");
  assert.match(parsed.version, /^\d+$/);
});

test("agent-kit-version bridge sets an explicit version", async () => {
  const root = await makeKit();
  const result = runBridge(["set", root, "5"]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.next, "5");

  const after = JSON.parse(runBridge(["get", root]).stdout);
  assert.equal(after.version, "5");
});

test("agent-kit-version bridge advances to the next version", async () => {
  const root = await makeKit();
  runBridge(["set", root, "3"]);
  const result = runBridge(["next", root]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.previous, "3");
  assert.equal(parsed.next, "4");
});

test("agent-kit-version bridge surfaces a user-facing error on invalid version", async () => {
  const root = await makeKit();
  const result = runBridge(["set", root, "not-a-version"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /version|integer/i);
});
