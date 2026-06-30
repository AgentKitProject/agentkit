import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newDb } from "pg-mem";
import { PostgresOrgStore, type PgPool } from "../lib/store/postgres-org-store.ts";
import * as handlers from "../lib/profile-api/org-handlers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "db", "migrations");
const schemaSql = readFileSync(join(migrationsDir, "0002_orgs.sql"), "utf8");
const monthlyLimitsSql = readFileSync(join(migrationsDir, "0003_org_monthly_limits.sql"), "utf8");

async function freshStore(): Promise<PostgresOrgStore> {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool() as unknown as PgPool;
  await pool.query(schemaSql);
  await pool.query(monthlyLimitsSql);
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

test("monthly limits round-trip (nullable caps) + clear", async () => {
  const store = await freshStore();
  const org = await store.createOrg({ displayName: "Team", ownerUserId: "u_owner" });

  // No limits configured yet.
  assert.equal(await store.getOrgMonthlyLimits(org.orgId), undefined);

  await store.setOrgMonthlyLimits(org.orgId, {
    limits: { poolCents: 10000, poolMinutes: null, memberCapCents: 2500, memberCapMinutes: 60 },
    updatedByUserId: "u_owner",
  });
  const rec = await store.getOrgMonthlyLimits(org.orgId);
  assert.deepEqual(rec?.limits, {
    poolCents: 10000,
    poolMinutes: null,
    memberCapCents: 2500,
    memberCapMinutes: 60,
  });

  // Upsert overwrites.
  await store.setOrgMonthlyLimits(org.orgId, {
    limits: { poolCents: null, poolMinutes: null, memberCapCents: null, memberCapMinutes: null },
    updatedByUserId: "u_owner",
  });
  assert.deepEqual((await store.getOrgMonthlyLimits(org.orgId))?.limits, {
    poolCents: null,
    poolMinutes: null,
    memberCapCents: null,
    memberCapMinutes: null,
  });

  await store.clearOrgMonthlyLimits(org.orgId);
  assert.equal(await store.getOrgMonthlyLimits(org.orgId), undefined);
});

test("usage accumulates per (org, member, period) and summary aggregates", async () => {
  const store = await freshStore();
  const org = await store.createOrg({ displayName: "Team", ownerUserId: "u_owner" });

  assert.deepEqual(await store.getMemberUsage(org.orgId, "u_owner", "2026-06"), {
    spentCents: 0,
    activeMinutes: 0,
  });

  await store.recordOrgUsage(org.orgId, "u_owner", "2026-06", 100, 5);
  await store.recordOrgUsage(org.orgId, "u_owner", "2026-06", 50, 3);
  await store.recordOrgUsage(org.orgId, "u_member", "2026-06", 200, 10);
  // Different period is isolated.
  await store.recordOrgUsage(org.orgId, "u_owner", "2026-07", 999, 99);

  assert.deepEqual(await store.getMemberUsage(org.orgId, "u_owner", "2026-06"), {
    spentCents: 150,
    activeMinutes: 8,
  });

  const summary = await store.getOrgUsageSummary(org.orgId, "2026-06");
  assert.equal(summary.period, "2026-06");
  assert.equal(summary.orgTotalCents, 350);
  assert.equal(summary.orgTotalMinutes, 18);
  assert.equal(summary.members.length, 2);
});

test("checkOrgUsageRemaining: no limits → allowed, all remaining null", async () => {
  const store = await freshStore();
  const org = await store.createOrg({ displayName: "Team", ownerUserId: "u_owner" });
  await store.recordOrgUsage(org.orgId, "u_owner", "2026-06", 500, 30);
  const check = await store.checkOrgUsageRemaining(org.orgId, "u_owner", "2026-06");
  assert.deepEqual(check, {
    allowed: true,
    memberRemainingCents: null,
    memberRemainingMinutes: null,
    poolRemainingCents: null,
    poolRemainingMinutes: null,
  });
});

test("checkOrgUsageRemaining: computes remaining per capped unit/scope", async () => {
  const store = await freshStore();
  const org = await store.createOrg({ displayName: "Team", ownerUserId: "u_owner" });
  await store.setOrgMonthlyLimits(org.orgId, {
    limits: { poolCents: 1000, poolMinutes: null, memberCapCents: 300, memberCapMinutes: 60 },
    updatedByUserId: "u_owner",
  });
  // Member uses some; another member contributes to the pool.
  await store.recordOrgUsage(org.orgId, "u_owner", "2026-06", 100, 20);
  await store.recordOrgUsage(org.orgId, "u_member", "2026-06", 250, 5);

  const check = await store.checkOrgUsageRemaining(org.orgId, "u_owner", "2026-06");
  assert.equal(check.allowed, true);
  assert.equal(check.memberRemainingCents, 200); // 300 - 100
  assert.equal(check.memberRemainingMinutes, 40); // 60 - 20
  assert.equal(check.poolRemainingCents, 650); // 1000 - (100+250)
  assert.equal(check.poolRemainingMinutes, null); // unlimited
});

test("checkOrgUsageRemaining: exhausting any capped unit blocks (allowed=false)", async () => {
  const store = await freshStore();
  const org = await store.createOrg({ displayName: "Team", ownerUserId: "u_owner" });
  await store.setOrgMonthlyLimits(org.orgId, {
    limits: { poolCents: null, poolMinutes: null, memberCapCents: 100, memberCapMinutes: null },
    updatedByUserId: "u_owner",
  });
  await store.recordOrgUsage(org.orgId, "u_owner", "2026-06", 100, 0);
  const check = await store.checkOrgUsageRemaining(org.orgId, "u_owner", "2026-06");
  assert.equal(check.memberRemainingCents, 0);
  assert.equal(check.allowed, false);
});

test("usage + monthly limits handlers: gate + service paths", async () => {
  const store = await freshStore();
  const org = await store.createOrg({ displayName: "Team", ownerUserId: "u_owner" });
  await store.addMember(org.orgId, "u_member", "member", "u_owner");
  await store.acceptInvite(org.orgId, "u_member");

  // Non-manager cannot set monthly limits.
  const denied = await handlers.setOrgMonthlyLimits(store, org.orgId, "u_member", {
    poolCents: null,
    poolMinutes: null,
    memberCapCents: 100,
    memberCapMinutes: null,
  });
  assert.equal(denied.status, 403);

  // Owner can.
  const ok = await handlers.setOrgMonthlyLimits(store, org.orgId, "u_owner", {
    poolCents: null,
    poolMinutes: null,
    memberCapCents: 100,
    memberCapMinutes: null,
  });
  assert.equal(ok.status, 200);

  // Status returns the caps (owner/admin).
  const status = await handlers.orgMonthlyLimitsStatus(store, org.orgId, "u_owner");
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, {
    poolCents: null,
    poolMinutes: null,
    memberCapCents: 100,
    memberCapMinutes: null,
  });

  // Service record + check (no role gate).
  const recorded = await handlers.recordOrgUsage(store, org.orgId, {
    userId: "u_member",
    period: "2026-06",
    addCents: 40,
    addMinutes: 2,
  });
  assert.equal(recorded.status, 200);

  const checked = await handlers.checkOrgUsage(store, org.orgId, "u_member", "2026-06");
  assert.equal(checked.status, 200);
  assert.equal((checked.body as Record<string, unknown>).memberRemainingCents, 60);

  // Summary (owner/admin).
  const summary = await handlers.orgUsageSummary(store, org.orgId, "u_owner", "2026-06");
  assert.equal(summary.status, 200);
  assert.equal((summary.body as Record<string, unknown>).orgTotalCents, 40);

  // Bad period rejected.
  await assert.rejects(() => handlers.orgUsageSummary(store, org.orgId, "u_owner", "2026-6"));
  await assert.rejects(() => handlers.checkOrgUsage(store, org.orgId, "u_member", "nope"));
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
