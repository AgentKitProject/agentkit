import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The duplicate-version affordance is implemented in src/App.tsx. We extract the
// `isDuplicateVersionError` helper directly from source and unit-test its behavior,
// plus assert the bump-then-resubmit wiring is present.

async function loadIsDuplicateVersionError() {
  const source = await readFile("src/App.tsx", "utf8");
  const match = source.match(/function isDuplicateVersionError\([^)]*\)[^{]*\{[\s\S]*?\n\}/);
  assert.ok(match, "isDuplicateVersionError helper must exist in src/App.tsx");
  // Strip the TypeScript parameter + return type annotations so the body runs as plain JS.
  const jsSource = match[0]
    .replace(/\(message[^)]*\)/, "(message)")
    .replace(/\)\s*:\s*boolean\s*\{/, ") {");
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${jsSource}\nreturn isDuplicateVersionError;`);
  return factory();
}

test("isDuplicateVersionError matches the backend 409 duplicate message", async () => {
  const isDuplicateVersionError = await loadIsDuplicateVersionError();
  assert.equal(
    isDuplicateVersionError("Hosted AgentKitMarket already has an active submission for this kit/version."),
    true,
  );
});

test("isDuplicateVersionError is case-insensitive", async () => {
  const isDuplicateVersionError = await loadIsDuplicateVersionError();
  assert.equal(
    isDuplicateVersionError("ALREADY HAS AN ACTIVE SUBMISSION FOR THIS KIT/VERSION"),
    true,
  );
});

test("isDuplicateVersionError ignores unrelated and empty errors", async () => {
  const isDuplicateVersionError = await loadIsDuplicateVersionError();
  assert.equal(isDuplicateVersionError("Validation failed."), false);
  assert.equal(isDuplicateVersionError(""), false);
  assert.equal(isDuplicateVersionError(null), false);
  assert.equal(isDuplicateVersionError(undefined), false);
});

test("submit flow wires bump-then-resubmit and the Submit-as-next affordance", async () => {
  const source = await readFile("src/App.tsx", "utf8");
  // Phase 0: the next_agent_kit_version invoke moved behind the ForgeClient.
  const tauriClientSource = await readFile("src/forge-client/tauri-client.ts", "utf8");
  assert.match(source, /bumpVersionAndResubmit/);
  assert.match(tauriClientSource, /next_agent_kit_version/);
  assert.match(source, /forge\.nextAgentKitVersion/);
  assert.match(source, /Submit as \$\{duplicateVersion\.next\}/);
  assert.match(source, /market-submit-duplicate-version/);
});
