import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getPublicProfileForUser, normalizePublicProfile, PROFILE_FALLBACK } from "./profile/profile-client.ts";

describe("profile-client", () => {
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.PROFILE_API_BASE_URL;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalBaseUrl === undefined) {
      delete process.env.PROFILE_API_BASE_URL;
    } else {
      process.env.PROFILE_API_BASE_URL = originalBaseUrl;
    }
  });

  it("fetches the Profile API public route by userId (no /public suffix)", async () => {
    process.env.PROFILE_API_BASE_URL = "https://profile-api.example.com/prod/";
    let requestedUrl: string | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          userId: "user_123",
          displayName: "Finance Builder",
          handle: "finance-builder",
          avatarInitials: "FB",
          verified: true
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const profile = await getPublicProfileForUser("user_123");

    assert.equal(requestedUrl, "https://profile-api.example.com/prod/profiles/user_123");
    assert.equal(profile.displayName, "Finance Builder");
    assert.equal(profile.handle, "finance-builder");
  });

  it("falls back to the safe profile when the Profile API rejects the request", async () => {
    process.env.PROFILE_API_BASE_URL = "https://profile-api.example.com/prod";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "Missing Authentication Token" }), { status: 403 })) as typeof fetch;

    assert.deepEqual(await getPublicProfileForUser("user_123"), PROFILE_FALLBACK);
  });

  it("normalizes wrapped public profile responses", () => {
    assert.deepEqual(
      normalizePublicProfile({
        item: {
          displayName: "Finance Builder",
          handle: "finance-builder",
          avatarInitials: "FB",
          verified: true
        }
      }),
      {
        displayName: "Finance Builder",
        handle: "finance-builder",
        avatarInitials: "FB",
        verified: true
      }
    );
  });

  it("uses a safe fallback profile shape", () => {
    assert.deepEqual(PROFILE_FALLBACK, {
      displayName: null,
      handle: null,
      avatarInitials: "AK",
      verified: false
    });
  });
});
