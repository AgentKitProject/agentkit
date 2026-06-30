import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newDb } from "pg-mem";
import { PostgresOrgStore, type PgPool } from "../lib/store/postgres-org-store.ts";
import * as handlers from "../lib/profile-api/org-handlers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "db", "migrations", "0002_orgs.sql"), "utf8");

async function freshStore(): Promise<PostgresOrgStore> {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool() as unknown as PgPool;
  await pool.query(schemaSql);
  return new PostgresOrgStore(pool);
}

test("createOrg creates an org + an active owner membership", async () => {
  const store = await freshStore();
  const org = await store.createOrg({ displayName: "Acme", ownerUserId: "u_owner" });
  assert.equal(org.displayName, "Acme");
  assert.equal(org.type, "team");
  assert.equal(org.ownerUserId, "u_owner");
  assert.ok(org.orgId.startsWith("org_"));
  assert.equal(org.slug, "acme");

  const owner = await store.getMembership(org.orgId, "u_owner");
  assert.equal(owner?.role, "owner");
  assert.equal(owner?.status, "active");

  const again = await store.getOrg(org.orgId);
  assert.equal(again?.orgId, org.orgId);
  const bySlug = await store.getOrgBySlug("acme");
  assert.equal(bySlug?.orgId, org.orgId);
});

test("slug dedupes with a numeric suffix", async () => {
  const store = await freshStore();
  const a = await store.createOrg({ displayName: "Acme", ownerUserId: "u1" });
  const b = await store.createOrg({ displayName: "Acme", ownerUserId: "u2" });
  assert.equal(a.slug, "acme");
  assert.equal(b.slug, "acme-2");
});

test("ensurePersonalOrg is idempotent", async () => {
  const store = await freshStore();
  const first = await store.ensurePersonalOrg("u_solo", "Solo Dev");
  assert.equal(first.type, "personal");
  const second = await store.ensurePersonalOrg("u_solo", "Solo Dev");
  assert.equal(second.orgId, first.orgId);
});

test("invite → accept flips membership to active and clears the invite", async () => {
  const store = await freshStore();
  const org = await store.createOrg({ displayName: "Team", ownerUserId: "u_owner" });

  await store.addMember(org.orgId, "u_member", "member", "u_owner");
  const invited = await store.getMembership(org.orgId, "u_member");
  assert.equal(invited?.status, "invited");
  assert.equal((await store.listInvitesForUser("u_member")).length, 1);

  const accepted = await store.acceptInvite(org.orgId, "u_member");
  assert.equal(accepted?.status, "active");
  assert.equal((await store.listInvitesForUser("u_member")).length, 0);

  const orgs = await store.listOrgsForUser("u_member");
  assert.equal(orgs.length, 1);
  assert.equal(orgs[0]?.orgId, org.orgId);
});

test("email invite is claimed on first login (creates active membership)", async () => {
  const store = await freshStore();
  const org = await store.createOrg({ displayName: "Team", ownerUserId: "u_owner" });
  await store.createEmailInvite(org.orgId, "New@Example.com ", "member", "u_owner");

  // Normalized lookup (trim + lowercase).
  assert.equal((await store.listInvitesByEmail("new@example.com")).length, 1);

  const created = await store.claimInvitesByEmail("new@example.com", "u_new");
  assert.equal(created.length, 1);
  assert.equal(created[0]?.status, "active");
  // Idempotent: a second claim does nothing.
  assert.equal((await store.claimInvitesByEmail("new@example.com", "u_new")).length, 0);
});

test("removeMember marks membership removed and drops it from listOrgsForUser", async () => {
  const store = await freshStore();
  const org = await store.createOrg({ displayName: "Team", ownerUserId: "u_owner" });
  await store.addMember(org.orgId, "u_member", "member", "u_owner");
  await store.acceptInvite(org.orgId, "u_member");
  await store.removeMember(org.orgId, "u_member");
  assert.equal((await store.listOrgsForUser("u_member")).length, 0);
  const m = await store.getMembership(org.orgId, "u_member");
  assert.equal(m?.status, "removed");
});

test("provider key + run budget round-trip", async () => {
  const store = await freshStore();
  const org = await store.createOrg({ displayName: "Team", ownerUserId: "u_owner" });

  await store.setOrgProviderKey(org.orgId, {
    providerType: "openai",
    apiKeyCiphertext: "ciphertext-xyz",
    baseUrl: "https://api.example.com",
    updatedByUserId: "u_owner",
  });
  const key = await store.getOrgProviderKey(org.orgId, "openai");
  assert.equal(key?.apiKeyCiphertext, "ciphertext-xyz");
  assert.equal(key?.baseUrl, "https://api.example.com");
  assert.equal((await store.listOrgProviderKeys(org.orgId)).length, 1);
  await store.clearOrgProviderKey(org.orgId, "openai");
  assert.equal(await store.getOrgProviderKey(org.orgId, "openai"), undefined);

  await store.setOrgRunBudget(org.orgId, { budgetCents: 500, updatedByUserId: "u_owner" });
  assert.equal((await store.getOrgRunBudget(org.orgId))?.budgetCents, 500);
  await store.clearOrgRunBudget(org.orgId);
  assert.equal(await store.getOrgRunBudget(org.orgId), undefined);
});

test("deleteOrg refuses a personal org, deletes a team org via handler", async () => {
  const store = await freshStore();
  const personal = await store.ensurePersonalOrg("u_owner", "Solo");
  const refused = await handlers.deleteOrg(store, personal.orgId, "u_owner");
  assert.equal(refused.status, 409);

  const team = await store.createOrg({ displayName: "Team", ownerUserId: "u_owner" });
  const ok = await handlers.deleteOrg(store, team.orgId, "u_owner");
  assert.equal(ok.status, 200);
  assert.equal(await store.getOrg(team.orgId), undefined);
});

test("handler role gate: a non-manager cannot add members", async () => {
  const store = await freshStore();
  const org = await store.createOrg({ displayName: "Team", ownerUserId: "u_owner" });
  await store.addMember(org.orgId, "u_member", "member", "u_owner");
  await store.acceptInvite(org.orgId, "u_member");

  const denied = await handlers.addMember(store, org.orgId, "u_member", {
    userId: "u_other",
    role: "member",
  });
  assert.equal(denied.status, 403);

  const allowed = await handlers.addMember(store, org.orgId, "u_owner", {
    userId: "u_other",
    role: "member",
  });
  assert.equal(allowed.status, 201);
});

test("getMembership handler returns {role,status} or 404", async () => {
  const store = await freshStore();
  const org = await store.createOrg({ displayName: "Team", ownerUserId: "u_owner" });
  const found = await handlers.getMembership(store, org.orgId, "u_owner");
  assert.equal(found.status, 200);
  assert.deepEqual(found.body, { role: "owner", status: "active" });

  const missing = await handlers.getMembership(store, org.orgId, "u_nobody");
  assert.equal(missing.status, 404);
});

test("resolve hot-paths apply the single-matching-org rule (fail-open)", async () => {
  const store = await freshStore();
  // No orgs → found:false.
  assert.deepEqual(
    (await handlers.resolveUserOrgApiKey(store, "u_x", "openai")).body,
    { found: false },
  );

  const org = await store.createOrg({ displayName: "Team", ownerUserId: "u_owner" });
  await store.setOrgProviderKey(org.orgId, {
    providerType: "openai",
    apiKeyCiphertext: "ct",
    updatedByUserId: "u_owner",
  });
  // Exactly one active-member org with a key for the provider → found.
  const resolved = await handlers.resolveUserOrgApiKey(store, "u_owner", "openai");
  const body = resolved.body as Record<string, unknown>;
  assert.equal(body.found, true);
  assert.equal(body.orgId, org.orgId);
  assert.equal(body.apiKey, "ct"); // decryptSecret is a no-op when no secret is set

  await store.setOrgRunBudget(org.orgId, { budgetCents: 250, updatedByUserId: "u_owner" });
  assert.deepEqual(
    (await handlers.resolveUserOrgRunBudget(store, "u_owner")).body,
    { found: true, budgetCents: 250 },
  );
});

test("encrypt/decrypt round-trips a provider key through the handlers", async () => {
  process.env.PROFILE_KEY_ENCRYPTION_SECRET = "0".repeat(64); // 64 hex chars
  const store = await freshStore();
  const org = await store.createOrg({ displayName: "Team", ownerUserId: "u_owner" });

  const setRes = await handlers.setOrgApiKey(store, org.orgId, "u_owner", {
    apiKey: "sk-secret-value",
    providerType: "anthropic",
  });
  assert.equal(setRes.status, 200);

  // Stored value must be ciphertext, not the raw key.
  const stored = await store.getOrgProviderKey(org.orgId, "anthropic");
  assert.ok(stored);
  assert.ok(stored!.apiKeyCiphertext.startsWith("enc:v1:"));
  assert.notEqual(stored!.apiKeyCiphertext, "sk-secret-value");

  // Status masks; resolve decrypts.
  const status = await handlers.orgApiKeyStatus(store, org.orgId, "u_owner");
  const providers = (status.body as { providers: { maskedKey: string }[] }).providers;
  assert.equal(providers[0]?.maskedKey, "…alue");

  const resolved = await handlers.resolveUserOrgApiKey(store, "u_owner", "anthropic");
  assert.equal((resolved.body as Record<string, unknown>).apiKey, "sk-secret-value");

  delete process.env.PROFILE_KEY_ENCRYPTION_SECRET;
});
