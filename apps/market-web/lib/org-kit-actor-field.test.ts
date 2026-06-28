import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

// Regression guard for the kit transfer / visibility proxy field name.
//
// The market-core backend handlers for adminTransferKit / adminSetKitVisibility
// read the acting user from `body.actorUserId` (same as the org member-add/remove
// handlers). The browser + forge proxy layers must inject that exact field.
//
// A prior bug injected `requestedByUserId` instead, which the backend ignores —
// every transfer/visibility call 400'd with "actorUserId is required" in
// production (both the web UI and the Forge bearer path). Lock the field name so
// it can't silently drift again.
describe("org kit transfer/visibility proxy actor field", () => {
  it("injects actorUserId (not requestedByUserId) in both proxy layers", async () => {
    const browserOrgs = await readFile(new URL("./browser-orgs.ts", import.meta.url), "utf8");
    const forgeOrgs = await readFile(new URL("./forge-orgs.ts", import.meta.url), "utf8");

    // The wrong field name must not reappear in either proxy.
    assert.doesNotMatch(browserOrgs, /requestedByUserId/);
    assert.doesNotMatch(forgeOrgs, /requestedByUserId/);

    // Each proxy file injects the actor for the two backend kit-ownership ops.
    for (const source of [browserOrgs, forgeOrgs]) {
      const actorInjections = source.match(/actorUserId: user\.id/g) ?? [];
      assert.ok(
        actorInjections.length >= 2,
        "expected transfer + visibility proxies to inject actorUserId: user.id"
      );
    }
  });
});
