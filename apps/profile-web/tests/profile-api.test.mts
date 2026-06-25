import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newDb } from "pg-mem";
import { publicPublisherProfileSchema } from "@agentkitforge/contracts";
import { PostgresProfileStore, type PgQueryable } from "../lib/store/postgres-store.ts";
import {
  getCurrentProfile,
  getPublicProfileByHandle,
  getPublicProfileByUserId,
  updateCurrentProfile,
} from "../lib/profile-api/handlers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "db", "migrations", "0001_profiles.sql"), "utf8");

async function freshStore(): Promise<PostgresProfileStore> {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool() as unknown as PgQueryable;
  await pool.query(schemaSql);
  return new PostgresProfileStore(pool);
}

const ctx = { userId: "user_123", email: "ada@example.com" };

test("GET /me lazy-creates a profile on first read", async () => {
  const store = await freshStore();

  assert.equal(await store.getByUserId(ctx.userId), null);

  const result = await getCurrentProfile(store, ctx);
  assert.equal(result.status, 200);

  const body = result.body as Record<string, unknown>;
  assert.equal(body.userId, ctx.userId);
  assert.equal(body.email, ctx.email);
  assert.equal(body.role, "user");
  assert.equal(body.verified, false);
  assert.equal(body.displayName, null);
  assert.equal(body.handle, null);
  assert.ok(typeof body.createdAt === "string");
  assert.ok(typeof body.updatedAt === "string");

  // Row now persisted; second read returns the same identity (idempotent create).
  const again = await getCurrentProfile(store, ctx);
  assert.equal((again.body as Record<string, unknown>).createdAt, body.createdAt);
});

test("PUT /me returns the full profile shape (email + role + timestamps)", async () => {
  const store = await freshStore();

  const result = await updateCurrentProfile(store, ctx, {
    displayName: "Ada Lovelace",
    handle: "ada",
    bio: "Mathematician",
    websiteUrl: "https://example.com",
  });

  assert.equal(result.status, 200);
  const body = result.body as Record<string, unknown>;
  assert.equal(body.displayName, "Ada Lovelace");
  assert.equal(body.handle, "ada");
  assert.equal(body.bio, "Mathematician");
  assert.equal(body.websiteUrl, "https://example.com");
  assert.equal(body.avatarInitials, "AL"); // derived from displayName
  assert.equal(body.email, ctx.email);
  assert.equal(body.role, "user");
  assert.ok(typeof body.createdAt === "string");
  assert.ok(typeof body.updatedAt === "string");
});

test("public routes return exactly the publicPublisherProfileSchema fields (no leak)", async () => {
  const store = await freshStore();
  await updateCurrentProfile(store, ctx, { displayName: "Ada", handle: "ada" });

  for (const result of [
    await getPublicProfileByUserId(store, ctx.userId),
    await getPublicProfileByHandle(store, "ADA"), // case-insensitive lookup
  ]) {
    assert.equal(result.status, 200);
    const body = result.body as Record<string, unknown>;

    // Conforms to the locked contract schema...
    publicPublisherProfileSchema.parse(body);

    // ...and carries ONLY those keys — no email / role / createdAt / updatedAt leak.
    assert.deepEqual(
      Object.keys(body).sort(),
      ["avatarInitials", "bio", "displayName", "handle", "userId", "verified", "websiteUrl"],
    );
    assert.equal("email" in body, false);
    assert.equal("role" in body, false);
    assert.equal("createdAt" in body, false);
    assert.equal("updatedAt" in body, false);
  }
});

test("public routes 404 when the profile does not exist", async () => {
  const store = await freshStore();
  assert.equal((await getPublicProfileByUserId(store, "missing")).status, 404);
  assert.equal((await getPublicProfileByHandle(store, "ghosthandle")).status, 404);
});

test("PUT /me handle collision throws ApiError 409 'Handle is already taken'", async () => {
  const store = await freshStore();

  await updateCurrentProfile(store, { userId: "user_a" }, { handle: "shared" });

  await assert.rejects(
    () => updateCurrentProfile(store, { userId: "user_b" }, { handle: "shared" }),
    (error: unknown) => {
      const e = error as { statusCode?: number; message?: string };
      assert.equal(e.statusCode, 409);
      assert.equal(e.message, "Handle is already taken");
      return true;
    },
  );
});

test("PUT /me rejects invalid handle with the ported error message", async () => {
  const store = await freshStore();
  await assert.rejects(
    () => updateCurrentProfile(store, ctx, { handle: "ab" }),
    (error: unknown) => {
      const e = error as { statusCode?: number; message?: string };
      assert.equal(e.statusCode, 400);
      assert.equal(e.message, "Handle must be 3-32 characters");
      return true;
    },
  );
});

test("PUT /me rejects a reserved handle", async () => {
  const store = await freshStore();
  await assert.rejects(
    () => updateCurrentProfile(store, ctx, { handle: "admin" }),
    (error: unknown) => {
      assert.equal((error as { message?: string }).message, "Handle is reserved");
      return true;
    },
  );
});

test("PUT /me can clear a previously-set handle", async () => {
  const store = await freshStore();
  await updateCurrentProfile(store, ctx, { handle: "ada" });

  const cleared = await updateCurrentProfile(store, ctx, { handle: null });
  assert.equal((cleared.body as Record<string, unknown>).handle, null);

  // Handle is now free for another user.
  const other = await updateCurrentProfile(store, { userId: "user_z" }, { handle: "ada" });
  assert.equal((other.body as Record<string, unknown>).handle, "ada");
});
