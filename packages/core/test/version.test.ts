import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  formatDisplayVersion,
  getAgentKitVersion,
  isValidAgentKitVersion,
  nextAgentKitVersion,
  setAgentKitVersion
} from "../src/package/version.js";

function manifestWithVersion(version: string): string {
  return `# Agent Kit manifest
schemaVersion: "0.1"
kind: AgentKit
id: commented-kit
name: Commented Kit
version: ${version} # current published version
description: A kit with comments and varied fields.
author:
  name: AgentKitForge Test # the author
license: MIT
entrypoints:
  human: START_HERE.md
  agent: AGENTKIT.md
userExperience:
  setupLevel: low
compatibility:
  targets:
    - codex # only codex for now
risk:
  level: low
skills:
  - id: summarize
    path: skills/summarize/SKILL.md
    description: Summarize provided text.
    triggers:
      - summarize text
`;
}

const SEQUENTIAL_MANIFEST = manifestWithVersion(`"3"`);
const LEGACY_SEMVER_MANIFEST = manifestWithVersion(`"0.1.0"`);

async function tempKitWith(manifest: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentkit-version-"));
  await writeFile(path.join(dir, "agentkit.yaml"), manifest, "utf8");
  return dir;
}

describe("Agent Kit version API", () => {
  test("getAgentKitVersion returns the current sequential version", async () => {
    const kit = await tempKitWith(SEQUENTIAL_MANIFEST);
    await expect(getAgentKitVersion(kit)).resolves.toBe("3");
  });

  test("getAgentKitVersion normalizes legacy semver to 1", async () => {
    const kit = await tempKitWith(LEGACY_SEMVER_MANIFEST);
    await expect(getAgentKitVersion(kit)).resolves.toBe("1");
  });

  test("getAgentKitVersion reads a raw YAML integer version", async () => {
    const kit = await tempKitWith(manifestWithVersion("5"));
    await expect(getAgentKitVersion(kit)).resolves.toBe("5");
  });

  test("setAgentKitVersion updates and returns previous/next", async () => {
    const kit = await tempKitWith(SEQUENTIAL_MANIFEST);
    const result = await setAgentKitVersion(kit, 4);
    expect(result).toEqual({ previous: "3", next: "4" });
    await expect(getAgentKitVersion(kit)).resolves.toBe("4");
  });

  test("setAgentKitVersion accepts a numeric-string version", async () => {
    const kit = await tempKitWith(SEQUENTIAL_MANIFEST);
    await expect(setAgentKitVersion(kit, "7")).resolves.toEqual({
      previous: "3",
      next: "7"
    });
  });

  test("setAgentKitVersion rejects non-positive-integer values", async () => {
    const kit = await tempKitWith(SEQUENTIAL_MANIFEST);
    for (const bad of ["0", "-1", "1.5", "01", "v2", "1.2.3", "abc"]) {
      await expect(setAgentKitVersion(kit, bad)).rejects.toThrow(
        /positive integer/
      );
    }
    // Manifest unchanged on rejection.
    await expect(getAgentKitVersion(kit)).resolves.toBe("3");
  });

  test("nextAgentKitVersion auto-increments by 1", async () => {
    const kit = await tempKitWith(SEQUENTIAL_MANIFEST);
    await expect(nextAgentKitVersion(kit)).resolves.toEqual({
      previous: "3",
      next: "4"
    });
    await expect(getAgentKitVersion(kit)).resolves.toBe("4");
  });

  test("nextAgentKitVersion migrates legacy semver to v1 then increments to v2", async () => {
    const kit = await tempKitWith(LEGACY_SEMVER_MANIFEST);
    await expect(nextAgentKitVersion(kit)).resolves.toEqual({
      previous: "1",
      next: "2"
    });
    const updated = await readFile(path.join(kit, "agentkit.yaml"), "utf8");
    expect(updated).toContain('version: "2"');
    expect(updated).not.toContain("0.1.0");
  });

  test("setAgentKitVersion normalizes a legacy semver previous to 1", async () => {
    const kit = await tempKitWith(LEGACY_SEMVER_MANIFEST);
    await expect(setAgentKitVersion(kit, 5)).resolves.toEqual({
      previous: "1",
      next: "5"
    });
  });

  test("round-trip preserves comments, key order, and other fields", async () => {
    const kit = await tempKitWith(SEQUENTIAL_MANIFEST);
    await setAgentKitVersion(kit, 9);
    const updated = await readFile(path.join(kit, "agentkit.yaml"), "utf8");

    // Version changed and stays a quoted string.
    expect(updated).toContain('version: "9"');
    expect(updated).not.toContain('version: "3"');

    // Comments preserved.
    expect(updated).toContain("# Agent Kit manifest");
    expect(updated).toContain("# current published version");
    expect(updated).toContain("# the author");
    expect(updated).toContain("# only codex for now");

    // Key order preserved.
    const idx = (needle: string) => updated.indexOf(needle);
    expect(idx("schemaVersion:")).toBeLessThan(idx("kind:"));
    expect(idx("kind:")).toBeLessThan(idx("id:"));
    expect(idx("version:")).toBeLessThan(idx("description:"));
    expect(idx("description:")).toBeLessThan(idx("author:"));

    // schemaVersion untouched.
    expect(updated).toContain('schemaVersion: "0.1"');

    // Other fields untouched.
    expect(updated).toContain("id: commented-kit");
    expect(updated).toContain("setupLevel: low");
    expect(updated).toContain("- summarize text");
  });

  test("getAgentKitVersion errors cleanly when manifest is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agentkit-version-"));
    await expect(getAgentKitVersion(dir)).rejects.toThrow();
  });

  test("getAgentKitVersion errors cleanly when version field is absent", async () => {
    const kit = await tempKitWith('schemaVersion: "0.1"\nname: No Version\n');
    await expect(getAgentKitVersion(kit)).rejects.toThrow(
      /missing a `version`/
    );
  });

  test("isValidAgentKitVersion accepts positive integers only", () => {
    expect(isValidAgentKitVersion("1")).toBe(true);
    expect(isValidAgentKitVersion("42")).toBe(true);
    expect(isValidAgentKitVersion(2)).toBe(true);
    expect(isValidAgentKitVersion("0")).toBe(false);
    expect(isValidAgentKitVersion(0)).toBe(false);
    expect(isValidAgentKitVersion("-1")).toBe(false);
    expect(isValidAgentKitVersion("01")).toBe(false);
    expect(isValidAgentKitVersion("1.0")).toBe(false);
    expect(isValidAgentKitVersion(1.5)).toBe(false);
    expect(isValidAgentKitVersion("1.2.3")).toBe(false);
    expect(isValidAgentKitVersion("v1")).toBe(false);
  });

  test("formatDisplayVersion renders vN and migrates legacy values to v1", () => {
    expect(formatDisplayVersion("1")).toBe("v1");
    expect(formatDisplayVersion(3)).toBe("v3");
    expect(formatDisplayVersion("0.1.0")).toBe("v1");
    expect(formatDisplayVersion("garbage")).toBe("v1");
  });
});
