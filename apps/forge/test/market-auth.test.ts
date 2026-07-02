import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the AuthKit cookie-session accessor before importing the helper.
const withAuthMock = vi.fn();
vi.mock("@workos-inc/authkit-nextjs", () => ({ withAuth: (...args: unknown[]) => withAuthMock(...args) }));

import { getWorkosAccessToken, createSessionTokenStore } from "@/server/core/market-auth";

beforeEach(() => {
  withAuthMock.mockReset();
});

describe("market-auth (WorkOS access token from AuthKit session)", () => {
  it("returns the access token when a user is signed in", async () => {
    withAuthMock.mockResolvedValue({ user: { id: "u1" }, accessToken: "tok-abc" });
    expect(await getWorkosAccessToken()).toBe("tok-abc");
  });

  it("returns null when there is no signed-in user", async () => {
    withAuthMock.mockResolvedValue({ user: null });
    expect(await getWorkosAccessToken()).toBeNull();
  });

  it("returns null (does not throw) when withAuth rejects", async () => {
    withAuthMock.mockRejectedValue(new Error("no session"));
    expect(await getWorkosAccessToken()).toBeNull();
  });

  it("createSessionTokenStore forwards the live access token via get()", async () => {
    withAuthMock.mockResolvedValue({ user: { id: "u1" }, accessToken: "tok-live" });
    const store = await createSessionTokenStore();
    const session = await store.get();
    expect(session?.accessToken).toBe("tok-live");
    // set/clear are no-ops (the cookie session owns the lifecycle).
    await expect(store.set(session!)).resolves.toBeUndefined();
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it("createSessionTokenStore throws when there is no session", async () => {
    withAuthMock.mockResolvedValue({ user: null });
    await expect(createSessionTokenStore()).rejects.toThrow(/signed-in/i);
  });
});
