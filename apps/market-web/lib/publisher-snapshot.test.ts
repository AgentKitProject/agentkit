// Publisher-snapshot fallback: kit submission must work WITHOUT the optional
// Profile service (a self-host that didn't deploy AgentKitProfile).
// getPublisherSnapshotForUser derives the publisher display name from the OIDC
// identity when PROFILE_API_BASE_URL is unset; when Profile IS configured the
// behaviour is unchanged (a user with no display name is still asked to set one).
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getPublisherSnapshotForUser } from "./profile/profile-client.ts";

const ORIGINAL_BASE = process.env.PROFILE_API_BASE_URL;
const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  if (ORIGINAL_BASE === undefined) delete process.env.PROFILE_API_BASE_URL;
  else process.env.PROFILE_API_BASE_URL = ORIGINAL_BASE;
  globalThis.fetch = ORIGINAL_FETCH;
});

function stubProfile(profile: unknown) {
  globalThis.fetch = (async () => ({ ok: true, json: async () => profile })) as unknown as typeof fetch;
}

describe("getPublisherSnapshotForUser", () => {
  it("derives 'First Last' from the OIDC name when Profile is not configured", async () => {
    delete process.env.PROFILE_API_BASE_URL;
    const snap = await getPublisherSnapshotForUser({
      id: "u1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Smith"
    });
    assert.equal(snap.displayName, "Alice Smith");
    assert.equal(snap.avatarInitials, "AS");
  });

  it("falls back to the email local-part when there is no name (no Profile)", async () => {
    delete process.env.PROFILE_API_BASE_URL;
    const snap = await getPublisherSnapshotForUser({ id: "u2", email: "bob@example.com" });
    assert.equal(snap.displayName, "bob");
  });

  it("returns the Profile display name unchanged when Profile IS configured", async () => {
    process.env.PROFILE_API_BASE_URL = "https://profile.example";
    stubProfile({ displayName: "Carol Jones", handle: "carol", avatarInitials: "CJ", verified: true });
    const snap = await getPublisherSnapshotForUser({
      id: "u3",
      email: "carol@example.com",
      firstName: "Carol",
      lastName: "Jones"
    });
    assert.equal(snap.displayName, "Carol Jones");
    assert.equal(snap.handle, "carol");
  });

  it("keeps a null display name (hosted requires it) when Profile is configured but empty", async () => {
    process.env.PROFILE_API_BASE_URL = "https://profile.example";
    stubProfile({ displayName: null, handle: null, avatarInitials: null, verified: false });
    const snap = await getPublisherSnapshotForUser({
      id: "u4",
      email: "dave@example.com",
      firstName: "Dave",
      lastName: "Ng"
    });
    assert.equal(snap.displayName, null);
  });
});
