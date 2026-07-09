import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { targets, envName, RUN_ID, catalogIsPublic } from "../../lib/targets";
import { STORAGE_STATE_PATH, hasRealSession } from "../../global-setup";

// AgentKitProfile ORG-GOVERNANCE CUJs (apps/profile-web). Mirrors the org
// lifecycle in cuj/profile.spec.ts and drives the deeper governance surfaces:
// role assignment, member removal, org shared API keys, per-run budget, and
// monthly limits, plus handle-uniqueness and the Connected Apps page.
//
// Tag rules (see playwright.config.ts):
//   - PROMOTED → the cuj project runs every test on gamma and they now gate
//     deploys; the @reversible subset also runs on prod via prod-cuj.
//   - @reversible → also prod-safe (creates+deletes its own RUN_ID artifacts,
//     no money, no LLM/compute spend, no irreversible writes).
//   - Untagged-reversible + `test.skip(envName !== "gamma", …)` → gamma-only.
//
// UI map (real selectors/routes — read from source, not invented):
//   Routes (profile-web, `${PROFILE}` = targets.profile):
//     - /account                         → AccountShell h1 "Account overview"
//     - /account/profile                 → ProfileEditor: input[name="displayName"],
//                                           input[name="handle"]; "Save profile"
//                                           button; "Saved" / "Could not save" spans;
//                                           inline field error "That handle is reserved."
//     - /account/orgs                    → AccountShell h1 "Organizations";
//                                           "New organization" button OR the admin gate
//                                           text "Only an administrator can create …"
//     - /account/orgs/{orgId}            → AccountShell h1 "Organization details";
//                                           OrgMembersPanel h2 "Members" + h3 "Add member";
//                                           owner/admin-only panels: h2 "Organization API
//                                           keys" (+ h3 "Add or update a key", "Save key",
//                                           "No org keys configured", "…<last4>" mask,
//                                           row "Clear" button); h2 "Organization default
//                                           run budget" (+ "Save budget", "Clear org
//                                           default", "Current org default: $X per run",
//                                           "No org default set"); h2 "Organization monthly
//                                           limits" (+ "Save limits", "Clear all", "Current
//                                           monthly limits set", "No monthly limits set").
//     - /account/products                → AccountShell h1 "Connected apps"; ConnectedApps
//                                           Cards h2 "AgentKitForge"/"AgentKitMarket"/
//                                           "AgentKitAuto", each with an <a> "Open"
//                                           (target=_blank); "No connected apps are
//                                           configured for this instance." empty state.
//   Member rows: div.flex.items-center.justify-between → userId div + "{role} · {status}"
//     subtitle div + a "Remove" button. Roles: owner/admin/member/viewer.
//   Org forms use plain <label> wrappers (NOT the `.ak-field` shell) — locate their
//     controls via label.filter({hasText}) → input/textarea/select (orgField helper).
//   Cookie APIs (browser iron-session): GET/POST /api/orgs, DELETE /api/orgs/{id},
//     GET/POST /api/orgs/{id}/members (legacy {userId,role} path adds an arbitrary
//     member row directly — the {email,role} path needs a registered account /
//     WorkOS lookup and otherwise becomes a pending invite with no row), PUT/GET
//     /api/profile/me.

test.skip(!hasRealSession(), "no E2E_USER/E2E_PASSWORD — CUJ suite skipped");

const PROFILE = targets.profile.replace(/\/$/, "");
const STATE = fileURLToPath(new URL("../../auth/state.json", import.meta.url));

// Other suites rely on the E2E user's canonical display name (it doubles as the
// Market publisher name); never leave it changed.
const CANONICAL_NAME = "AgentKit E2E";
// A unique, guaranteed-free handle for the "retry succeeds" step (lowercase,
// [a-z0-9_-], 3–32 chars).
const FREE_HANDLE = ("e2e-h-" + RUN_ID.replace(/[^a-z0-9]/gi, "").toLowerCase()).slice(0, 32);

type Org = { orgId: string; displayName: string; slug?: string; type?: string };
type PrivateProfile = {
  email: string;
  displayName: string;
  handle: string;
  avatarInitials: string;
  bio: string;
  websiteUrl: string;
};

// Artifacts created this run (best-effort cleanup guard).
const createdOrgIds: string[] = [];
// Captured in the handle test so the afterAll can re-restore if the test crashed
// mid-flight.
let capturedOriginalHandle: string | null = null;

// ---------------------------------------------------------------------------
// API helpers (cookie-authed — page.request / afterAll context share cookies)
// ---------------------------------------------------------------------------

async function getProfile(api: APIRequestContext): Promise<PrivateProfile> {
  const res = await api.get(`${PROFILE}/api/profile/me`);
  if (!res.ok()) throw new Error(`GET /api/profile/me -> HTTP ${res.status()}`);
  return (await res.json()) as PrivateProfile;
}

async function listOrgs(api: APIRequestContext): Promise<Org[]> {
  const res = await api.get(`${PROFILE}/api/orgs`);
  if (!res.ok()) throw new Error(`GET /api/orgs -> HTTP ${res.status()}`);
  const body = (await res.json()) as unknown;
  if (Array.isArray(body)) return body as Org[];
  const rec = body as Record<string, unknown>;
  for (const key of ["items", "orgs"]) if (Array.isArray(rec[key])) return rec[key] as Org[];
  return [];
}

/** Delete any of the signed-in user's orgs with this exact displayName (retry-safe pre-clean). */
async function preCleanOrgsByName(api: APIRequestContext, name: string): Promise<void> {
  for (const org of await listOrgs(api).catch(() => [] as Org[])) {
    if (org.displayName === name) {
      await api.delete(`${PROFILE}/api/orgs/${encodeURIComponent(org.orgId)}`).catch(() => {});
    }
  }
}

/** Create a team org; returns its id, or null when creation isn't permitted here. */
async function createTeamOrg(api: APIRequestContext, name: string): Promise<string | null> {
  const res = await api.post(`${PROFILE}/api/orgs`, { data: { displayName: name } });
  if (!res.ok()) return null;
  const body = (await res.json().catch(() => ({}))) as { item?: { orgId?: string } };
  if (body.item?.orgId) return body.item.orgId;
  return (await listOrgs(api)).find((o) => o.displayName === name)?.orgId ?? null;
}

/**
 * Add a member via the LEGACY {userId, role} route. This adds an (invited)
 * membership row for an ARBITRARY userId directly — the deterministic way to
 * make roles render without a second registered account (the UI's {email,role}
 * path resolves email→userId via a WorkOS lookup and, for an unregistered
 * email, stores a pending invite that produces NO member row).
 */
async function addMemberApi(api: APIRequestContext, orgId: string, userId: string, role: string) {
  return api.post(`${PROFILE}/api/orgs/${encodeURIComponent(orgId)}/members`, {
    data: { userId, role },
  });
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

async function gotoOrgDetail(page: Page, orgId: string): Promise<void> {
  await page.goto(`${PROFILE}/account/orgs/${encodeURIComponent(orgId)}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page).not.toHaveURL(/\/auth\/sign-in|\/realms\//);
  await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
}

/** A member row located by its (unique) userId text. */
function memberRow(page: Page, userId: string) {
  return page.locator("div.flex.items-center.justify-between").filter({ hasText: userId });
}

/** All "Remove" buttons on the org detail page == the member row count (only the
 *  members panel renders "Remove"; key/budget panels use "Clear"). */
function removeButtons(page: Page) {
  return page.getByRole("button", { name: "Remove", exact: true });
}

/** The input/textarea/select of an org-form field, located by its wrapping <label>. */
function orgField(page: Page, label: RegExp) {
  return page
    .locator("label")
    .filter({ hasText: label })
    .locator("input, textarea, select")
    .first();
}

/** Click "Save profile" and resolve the Saved/Could-not-save outcome. */
async function saveProfileForm(page: Page): Promise<"saved" | "error"> {
  await page.getByRole("button", { name: "Save profile" }).click();
  const saved = page.getByText("Saved", { exact: true });
  const failed = page.getByText("Could not save", { exact: true });
  await expect(saved.or(failed)).toBeVisible();
  return (await saved.isVisible()) ? "saved" : "error";
}

// ---------------------------------------------------------------------------
// Failure-tolerant cleanup: delete every RUN_ID org left behind, and restore the
// handle if the handle test crashed mid-change. Never throws.
// ---------------------------------------------------------------------------

test.afterAll(async () => {
  const api = await pwRequest.newContext({ storageState: STATE });
  try {
    for (const org of await listOrgs(api).catch(() => [] as Org[])) {
      if (createdOrgIds.includes(org.orgId) || org.displayName.startsWith(RUN_ID)) {
        await api.delete(`${PROFILE}/api/orgs/${encodeURIComponent(org.orgId)}`).catch(() => {});
      }
    }
    if (capturedOriginalHandle !== null) {
      const profile = await getProfile(api).catch(() => null);
      if (profile && (profile.handle ?? "") !== capturedOriginalHandle) {
        await api
          .put(`${PROFILE}/api/profile/me`, {
            data: {
              displayName: profile.displayName || CANONICAL_NAME,
              handle: capturedOriginalHandle,
              avatarInitials: profile.avatarInitials ?? "",
              bio: profile.bio ?? "",
              websiteUrl: profile.websiteUrl ?? "",
            },
          })
          .catch(() => {});
      }
    }
  } finally {
    await api.dispose();
  }
});

// ---------------------------------------------------------------------------
// 1. Role ASSIGNMENT — add an admin and a viewer; both roles render in the table
// ---------------------------------------------------------------------------

test("member role assignment renders admin and viewer roles @reversible", async ({ page }, testInfo) => {
  const name = `${RUN_ID}-roles`;
  const adminUser = `${RUN_ID}-usr-a`;
  const viewerUser = `${RUN_ID}-usr-v`;

  await preCleanOrgsByName(page.request, name);
  const orgId = await createTeamOrg(page.request, name);
  test.skip(!orgId, "org creation is not permitted for this identity here (admin-gated self-host)");
  createdOrgIds.push(orgId!);

  // Add two members with DISTINCT roles (not just "member"). Using the legacy
  // {userId,role} API path — see addMemberApi's note on why the UI email path
  // can't deterministically produce a member row.
  testInfo.annotations.push({
    type: "note",
    description:
      "members added via the cookie /api/orgs/{id}/members legacy {userId,role} route (arbitrary RUN_ID userIds); " +
      "the UI's email→member path needs a registered account and otherwise yields a pending invite with no row. " +
      "Role RENDERING is still asserted through the real Profile UI below.",
  });
  expect((await addMemberApi(page.request, orgId!, adminUser, "admin")).ok()).toBe(true);
  expect((await addMemberApi(page.request, orgId!, viewerUser, "viewer")).ok()).toBe(true);

  // The member table renders each role distinctly (userIds are role-word-free so
  // matching the role word proves the ROLE column, not the id).
  await gotoOrgDetail(page, orgId!);
  const adminRow = memberRow(page, adminUser);
  const viewerRow = memberRow(page, viewerUser);
  await expect(adminRow).toBeVisible();
  await expect(adminRow).toContainText("admin");
  await expect(viewerRow).toBeVisible();
  await expect(viewerRow).toContainText("viewer");
  // The creator is auto-enrolled as owner — its row renders too.
  await expect(page.getByText(/owner/).first()).toBeVisible();

  // Teardown (in-test; afterAll re-sweeps).
  await page.request.delete(`${PROFILE}/api/orgs/${encodeURIComponent(orgId!)}`).catch(() => {});
});

// ---------------------------------------------------------------------------
// 2. Permission ENFORCEMENT — a plain member is denied management (gamma-only).
// ---------------------------------------------------------------------------

test("plain member cannot manage members, keys, or budget", async () => {
  test.skip(envName !== "gamma", "permission enforcement is gamma-only (needs a second seeded identity)");
  // Even on gamma this cannot run with the current single-credential suite:
  test.skip(
    true,
    "requires a SECOND, non-owner Keycloak identity + its storageState. The E2E suite carries ONE credential " +
      "and is auto-enrolled as OWNER of every org it creates, so a plain member's DENIED experience cannot be " +
      "exercised: the server-side 403 (org-handlers.ts requireOrgManager / MANAGE_ROLES on POST+DELETE " +
      "/api/orgs/{id}/members, api-key, run-budget, monthly-limits) and the hidden OrgApiKeyPanel/OrgRunBudgetPanel/" +
      "OrgMonthlyLimitsPanel (canManage=false) both need an actor who is a member but not owner/admin. Seed a " +
      "second member identity to enable this journey.",
  );
});

// ---------------------------------------------------------------------------
// 3. Member REMOVAL — owner removes one of several members; row + count update
// ---------------------------------------------------------------------------

test("owner removes a member: row disappears and count decrements @reversible", async ({ page }, testInfo) => {
  const name = `${RUN_ID}-remove`;
  const member1 = `${RUN_ID}-usr-1`;
  const member2 = `${RUN_ID}-usr-2`;

  await preCleanOrgsByName(page.request, name);
  const orgId = await createTeamOrg(page.request, name);
  test.skip(!orgId, "org creation is not permitted for this identity here (admin-gated self-host)");
  createdOrgIds.push(orgId!);

  testInfo.annotations.push({
    type: "note",
    description:
      "members seeded via the cookie legacy {userId,role} route; REMOVAL is driven through the real UI Remove button.",
  });
  expect((await addMemberApi(page.request, orgId!, member1, "member")).ok()).toBe(true);
  expect((await addMemberApi(page.request, orgId!, member2, "member")).ok()).toBe(true);

  await gotoOrgDetail(page, orgId!);
  const row1 = memberRow(page, member1);
  const row2 = memberRow(page, member2);
  await expect(row1).toBeVisible();
  await expect(row2).toBeVisible();
  // owner + member1 + member2 = 3 removable rows.
  await expect(removeButtons(page)).toHaveCount(3);

  // Owner removes member1 via its row's Remove button.
  await row1.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(row1).toHaveCount(0); // the row disappears
  await expect(removeButtons(page)).toHaveCount(2); // count decremented
  await expect(row2).toBeVisible(); // the other member persists

  await page.request.delete(`${PROFILE}/api/orgs/${encodeURIComponent(orgId!)}`).catch(() => {});
});

// ---------------------------------------------------------------------------
// 4. Org shared API-KEY lifecycle (gamma-only): save → masked (…xxxx) → clear.
//    Reversible in itself, but scoped gamma-only per the suite's org-write policy.
// ---------------------------------------------------------------------------

test("org shared API key: save persists masked, then clears (gamma only)", async ({ page }) => {
  test.skip(envName !== "gamma", "org API-key writes are gamma-only in this suite");
  const name = `${RUN_ID}-apikey`;
  await preCleanOrgsByName(page.request, name);
  const orgId = await createTeamOrg(page.request, name);
  test.skip(!orgId, `org creation not permitted here (needed to own the API-key surface)`);
  createdOrgIds.push(orgId!);

  // A throwaway, never-usable key; its last 4 chars ("9z9z") are what the mask
  // "…9z9z" surfaces. Cleared in-test AND in the finally.
  const FAKE_KEY = "sk-ant-e2e-DO-NOT-USE-9z9z";

  try {
    await gotoOrgDetail(page, orgId!);
    // Owner-only surface (canManage=true because we own the org).
    await expect(page.getByRole("heading", { name: "Organization API keys" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Add or update a key" })).toBeVisible();

    // Provider defaults to Anthropic; enter the throwaway key and save.
    await orgField(page, /API key/).fill(FAKE_KEY);
    await page.getByRole("button", { name: "Save key" }).click();
    await expect(page.getByText("Anthropic key saved.")).toBeVisible();
    // Persists MASKED: only the last-4 shows; the raw key is never rendered.
    await expect(page.getByText(/9z9z/)).toBeVisible();
    await expect(page.getByText(/sk-ant-e2e/)).toHaveCount(0);

    // Survives a reload (read back from the store).
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Organization API keys" })).toBeVisible();
    await expect(page.getByText(/9z9z/)).toBeVisible();

    // Clear it → back to the empty state.
    await page.getByRole("button", { name: "Clear", exact: true }).first().click();
    await expect(page.getByText("Anthropic key cleared.")).toBeVisible();
    await expect(page.getByText("No org keys configured")).toBeVisible();
  } finally {
    await page.request.delete(`${PROFILE}/api/orgs/${encodeURIComponent(orgId!)}`).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 5. Org per-run BUDGET (gamma-only): set USD default → persists → clear.
// ---------------------------------------------------------------------------

test("org per-run budget: owner sets USD default, persists, clears (gamma only)", async ({ page }) => {
  test.skip(envName !== "gamma", "org budget writes are gamma-only in this suite");
  const name = `${RUN_ID}-budget`;
  await preCleanOrgsByName(page.request, name);
  const orgId = await createTeamOrg(page.request, name);
  test.skip(!orgId, "org creation not permitted here (needed to own the run-budget surface)");
  createdOrgIds.push(orgId!);

  try {
    await gotoOrgDetail(page, orgId!);
    await expect(page.getByRole("heading", { name: "Organization default run budget" })).toBeVisible();
    // Wait for loadStatus() to settle so it doesn't wipe our value mid-edit.
    await expect(page.getByText("No org default set")).toBeVisible();

    // Set a $0.50 default and save.
    await orgField(page, /Default run budget/).fill("0.50");
    await page.getByRole("button", { name: "Save budget" }).click();
    await expect(page.getByText("Org default run budget saved.")).toBeVisible();
    await expect(page.getByText("Current org default: $0.50 per run")).toBeVisible();

    // Survives a reload (store-backed).
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("Current org default: $0.50 per run")).toBeVisible();
    await expect(orgField(page, /Default run budget/)).toHaveValue("0.50");

    // Clear it.
    await page.getByRole("button", { name: "Clear org default" }).click();
    await expect(page.getByText("Org default run budget cleared.")).toBeVisible();
    await expect(page.getByText("No org default set")).toBeVisible();
  } finally {
    await page.request.delete(`${PROFILE}/api/orgs/${encodeURIComponent(orgId!)}`).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 6. Org MONTHLY LIMITS / pool (gamma-only): set pool + member cap → persists.
// ---------------------------------------------------------------------------

test("org monthly limits: owner sets pool and member cap, persists (gamma only)", async ({ page }) => {
  test.skip(envName !== "gamma", "org monthly-limit writes are gamma-only in this suite");
  const name = `${RUN_ID}-limits`;
  await preCleanOrgsByName(page.request, name);
  const orgId = await createTeamOrg(page.request, name);
  test.skip(!orgId, "org creation not permitted here (needed to own the monthly-limits surface)");
  createdOrgIds.push(orgId!);

  try {
    await gotoOrgDetail(page, orgId!);
    await expect(page.getByRole("heading", { name: "Organization monthly limits" })).toBeVisible();
    // Wait for the async loadStatus() to settle before filling — it repaints the
    // inputs to the server's empty state, and would otherwise wipe our values
    // mid-edit (an empty save). "No monthly limits set" only renders post-load.
    await expect(page.getByText("No monthly limits set")).toBeVisible();

    // Set an org-wide pool ($5) + a per-member cap ($2), then save.
    await orgField(page, /pool.*dollars/i).fill("5.00");
    await orgField(page, /per-member cap.*dollars/i).fill("2.00");
    await page.getByRole("button", { name: "Save limits" }).click();
    await expect(page.getByText("Organization monthly limits saved.")).toBeVisible();
    await expect(page.getByText("Current monthly limits set")).toBeVisible();

    // Survives a reload (store-backed status + repopulated fields).
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("Current monthly limits set")).toBeVisible();
    await expect(orgField(page, /pool.*dollars/i)).not.toHaveValue("");
    await expect(orgField(page, /per-member cap.*dollars/i)).not.toHaveValue("");

    // Clear them all.
    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(page.getByText("Organization monthly limits cleared.")).toBeVisible();
    await expect(page.getByText("No monthly limits set")).toBeVisible();
  } finally {
    await page.request.delete(`${PROFILE}/api/orgs/${encodeURIComponent(orgId!)}`).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 7. Handle uniqueness CONFLICT: unavailable handle rejected → a free one saves.
//    NOTE: a genuine cross-user "already taken" needs a second seeded account
//    (unavailable to this single-identity suite), so the deterministic proxy for
//    "handle unavailable" is a RESERVED handle ("admin") — same reject-then-recover
//    journey and same server-side uniqueness/availability guard.
// ---------------------------------------------------------------------------

test("handle conflict: unavailable handle rejected, a free handle saves @reversible", async ({ page }, testInfo) => {
  await page.goto(`${PROFILE}/account/profile`, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/auth\/sign-in|\/realms\//);
  // Wait for the profile form to hydrate — prod renders it slower than the 10s default.
  await expect(page.getByRole("heading", { name: "Your AgentKitProject profile" })).toBeVisible({
    timeout: 20_000
  });
  const displayNameInput = page.locator('input[name="displayName"]');
  const handleInput = page.locator('input[name="handle"]');
  await expect(displayNameInput).toBeVisible({ timeout: 20_000 });
  await expect(handleInput).toBeVisible({ timeout: 20_000 });

  // Capture the current handle so we can restore it (afterAll re-restores too).
  capturedOriginalHandle = (await handleInput.inputValue()).trim();
  // Any save needs a display name — keep the canonical one if it's somehow blank.
  if ((await displayNameInput.inputValue()).trim().length === 0) {
    await displayNameInput.fill(CANONICAL_NAME);
  }

  testInfo.annotations.push({
    type: "note",
    description:
      'a reserved handle ("admin") is the single-account proxy for "handle unavailable"; a true cross-user ' +
      '"already taken" would need a second seeded account.',
  });

  // 1) Claiming an UNAVAILABLE handle is rejected.
  await handleInput.fill("admin");
  expect(await saveProfileForm(page)).toBe("error");
  await expect(
    page.getByText("That handle is reserved.").or(page.getByText("Could not save", { exact: true })).first(),
  ).toBeVisible();

  // 2) Retrying a FREE, unique handle succeeds and persists.
  await handleInput.fill(FREE_HANDLE);
  expect(await saveProfileForm(page)).toBe("saved");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator('input[name="handle"]')).toHaveValue(FREE_HANDLE);
  expect((await getProfile(page.request)).handle).toBe(FREE_HANDLE);

  // Restore the original handle.
  await page.locator('input[name="handle"]').fill(capturedOriginalHandle);
  expect(await saveProfileForm(page)).toBe("saved");
});

// ---------------------------------------------------------------------------
// 8. Connected Apps page: lists ecosystem apps with working Open links.
// ---------------------------------------------------------------------------

test("connected apps page lists ecosystem apps with working Open links @reversible", async ({ page }, testInfo) => {
  await page.goto(`${PROFILE}/account/products`, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/auth\/sign-in|\/realms\//);
  await expect(page.getByRole("heading", { name: "Connected apps" })).toBeVisible();

  const openLinks = page.getByRole("link", { name: "Open", exact: true });
  const empty = page.getByText("No connected apps are configured for this instance.");
  await expect(openLinks.first().or(empty)).toBeVisible();

  if (await empty.isVisible().catch(() => false)) {
    // Self-host with no NEXT_PUBLIC_*_URL configured — the surface still rendered.
    testInfo.annotations.push({
      type: "note",
      description: "this instance surfaces no connected apps (no NEXT_PUBLIC_*_URL configured) — empty state asserted.",
    });
    return;
  }

  // Every Open link must be a working, absolute link that opens in a new tab.
  const count = await openLinks.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    await expect(openLinks.nth(i)).toHaveAttribute("href", /^https?:\/\//);
    await expect(openLinks.nth(i)).toHaveAttribute("target", "_blank");
  }

  // On the hosted (public) env all three ecosystem cards resolve.
  if (catalogIsPublic) {
    for (const name of ["AgentKitForge", "AgentKitMarket", "AgentKitAuto"]) {
      await expect(page.getByRole("heading", { name })).toBeVisible();
    }
    expect(count).toBe(3);
  }
});
