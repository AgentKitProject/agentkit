import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { targets, envName, RUN_ID } from "../../lib/targets";
import { hasRealSession } from "../../global-setup";

// AgentKitProfile CUJs. Auth comes from the shared storageState (cuj project).
//
// Tag rules: `@reversible` in the TITLE = safe for prod (reversible, zero
// spend). Untagged = gamma-only (org lifecycle on prod is covered manually).
//
// NOTE: other suites rely on the E2E user's display name being exactly
// "AgentKit E2E" (it doubles as the Market publisher name) — test 2 both
// exercises the edit journey and restores that invariant; a failure-tolerant
// afterAll re-restores it via the API.
test.skip(!hasRealSession(), "no E2E_USER/E2E_PASSWORD — CUJ checks skipped");

const PROFILE = targets.profile.replace(/\/$/, "");
const STATE = fileURLToPath(new URL("../../auth/state.json", import.meta.url));

const CANONICAL_NAME = "AgentKit E2E";
const TEMP_NAME = `AgentKit E2E ${RUN_ID.slice(-4)}`;
const PREFERRED_HANDLE = "e2e-agentkit";

type PrivateProfile = {
  email: string;
  displayName: string;
  handle: string;
  avatarInitials: string;
  bio: string;
  websiteUrl: string;
};
type Org = { orgId: string; displayName: string; slug?: string; type?: string };

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

// UI helpers -----------------------------------------------------------------

async function gotoProfileEditor(page: Page): Promise<void> {
  await page.goto(`${PROFILE}/account/profile`, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/auth\/sign-in|\/realms\//);
  await expect(page.locator('input[name="displayName"]')).toBeVisible();
}

/** Click "Save profile" and wait for the Saved/Could-not-save outcome. */
async function saveProfileForm(page: Page): Promise<"saved" | "error"> {
  await page.getByRole("button", { name: "Save profile" }).click();
  const saved = page.getByText("Saved", { exact: true });
  const failed = page.getByText("Could not save", { exact: true });
  await expect(saved.or(failed)).toBeVisible();
  return (await saved.isVisible()) ? "saved" : "error";
}

// Failure-tolerant cleanup: restore the canonical display name and remove any
// e2e-* orgs left behind by this run or a crashed earlier iteration.
const createdOrgIds: string[] = [];
test.afterAll(async () => {
  const api = await pwRequest.newContext({ storageState: STATE });
  try {
    const profile = await getProfile(api).catch(() => null);
    if (profile && profile.displayName !== CANONICAL_NAME) {
      await api
        .put(`${PROFILE}/api/profile/me`, {
          data: {
            displayName: CANONICAL_NAME,
            handle: profile.handle ?? "",
            avatarInitials: profile.avatarInitials ?? "",
            bio: profile.bio ?? "",
            websiteUrl: profile.websiteUrl ?? "",
          },
        })
        .catch(() => {});
    }
    for (const org of await listOrgs(api).catch(() => [] as Org[])) {
      if (createdOrgIds.includes(org.orgId) || org.displayName.startsWith("e2e-")) {
        await api.delete(`${PROFILE}/api/orgs/${encodeURIComponent(org.orgId)}`).catch(() => {});
      }
    }
  } finally {
    await api.dispose();
  }
});

// ---------------------------------------------------------------------------
// 1. Account page renders with the E2E identity
// ---------------------------------------------------------------------------

test("account page renders with the E2E identity @reversible", async ({ page }) => {
  await page.goto(`${PROFILE}/account`, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/auth\/sign-in|\/realms\//);
  await expect(page.getByRole("heading", { name: "Account overview" })).toBeVisible();
  // The profile summary shows the signed-in user's (private) email.
  const email = process.env.E2E_USER!.trim();
  await expect(page.getByText(email).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// 2. Display name set/update → restore
// ---------------------------------------------------------------------------

test("display name update and restore @reversible", async ({ page }) => {
  await gotoProfileEditor(page);
  const nameInput = page.locator('input[name="displayName"]');

  // Precondition other suites rely on: display name === "AgentKit E2E".
  if ((await nameInput.inputValue()).trim() !== CANONICAL_NAME) {
    await nameInput.fill(CANONICAL_NAME);
    expect(await saveProfileForm(page)).toBe("saved");
  }

  // Update to a RUN_ID-suffixed name and verify it persisted.
  await nameInput.fill(TEMP_NAME);
  expect(await saveProfileForm(page)).toBe("saved");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(nameInput).toHaveValue(TEMP_NAME);

  // Restore to exactly the canonical name; verify via UI and API.
  await nameInput.fill(CANONICAL_NAME);
  expect(await saveProfileForm(page)).toBe("saved");
  expect((await getProfile(page.request)).displayName).toBe(CANONICAL_NAME);
});

// ---------------------------------------------------------------------------
// 3. Handle + public profile
// ---------------------------------------------------------------------------

test("handle is set and the public profile page renders @reversible", async ({ page }) => {
  await gotoProfileEditor(page);
  const handleInput = page.locator('input[name="handle"]');
  let handle = (await handleInput.inputValue()).trim();

  if (!handle) {
    // Idempotent set. If the handle is already taken by SOMEONE ELSE the server
    // rejects the save — then we only assert the settings surface.
    await handleInput.fill(PREFERRED_HANDLE);
    if ((await saveProfileForm(page)) === "error") {
      await expect(page.getByRole("heading", { name: "Your AgentKitProject profile" })).toBeVisible();
      test.info().annotations.push({
        type: "note",
        description: `handle "${PREFERRED_HANDLE}" could not be claimed (likely taken) — settings surface asserted only`,
      });
      return;
    }
    handle = PREFERRED_HANDLE;
  }

  // Public profile renders for the handle.
  await page.goto(`${PROFILE}/u/${handle}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(`@${handle}`).first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// 4. GAMMA-ONLY (untagged): org create → owner membership renders → delete.
// Profile is the org system of record; on the self-host gamma instance org
// creation is admin-gated (the E2E user is a Keycloak `admins` member there).
// ---------------------------------------------------------------------------

test("org lifecycle: create → members render → delete (gamma only)", async ({ page }) => {
  test.skip(envName !== "gamma", "org lifecycle on prod is covered manually — gamma only");
  const orgName = `${RUN_ID}-org`;

  // Retry-defense: remove a leftover org with the same name from a prior attempt.
  for (const org of await listOrgs(page.request)) {
    if (org.displayName === orgName) await page.request.delete(`${PROFILE}/api/orgs/${encodeURIComponent(org.orgId)}`);
  }

  await page.goto(`${PROFILE}/account/orgs`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Organizations" })).toBeVisible();
  const newOrgButton = page.getByRole("button", { name: "New organization" });
  const adminGate = page.getByText("Only an administrator can create organizations");
  await expect(newOrgButton.or(adminGate)).toBeVisible();
  test.skip(await adminGate.isVisible(), "org creation is admin-gated here and the E2E user is not an admin");

  // Create via the UI.
  await newOrgButton.click();
  await page.getByLabel(/Display name/).fill(orgName);
  await page.getByRole("button", { name: "Create organization" }).click();

  // Track for cleanup FIRST (poll the API) so a UI-assert failure can't leak the org.
  let org: { orgId: string; displayName: string } | undefined;
  await expect
    .poll(async () => {
      org = (await listOrgs(page.request)).find((o) => o.displayName === orgName);
      return Boolean(org);
    })
    .toBe(true);
  createdOrgIds.push(org!.orgId);
  // The org renders in both the row title and the subtitle line — use .first()
  // (a bare getByText is a strict-mode violation with 2 matches).
  await expect(page.getByText(orgName).first()).toBeVisible();

  // Owner membership + members panel render on the org detail page.
  await page.goto(`${PROFILE}/account/orgs/${encodeURIComponent(org!.orgId)}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add member" })).toBeVisible();
  // The creator is auto-enrolled as owner: a member row shows "owner · <status>".
  await expect(page.getByText(/owner\s+·/).first()).toBeVisible();

  // Teardown via the UI (native confirm dialog).
  await page.goto(`${PROFILE}/account/orgs`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(orgName).first()).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator("div.flex").filter({ hasText: orgName }).getByRole("button", { name: "Delete" }).first().click();
  await expect(page.getByText(orgName)).toHaveCount(0);
  await expect
    .poll(async () => (await listOrgs(page.request)).some((o) => o.orgId === org!.orgId))
    .toBe(false);
});

// ---------------------------------------------------------------------------
// 5. GAMMA-ONLY (untagged): the org API-keys panel renders (no key is added).
// Uses its own API-created org so it doesn't depend on test 4's artifact.
// ---------------------------------------------------------------------------

test("org API-keys surface renders for an owner (gamma only)", async ({ page }) => {
  test.skip(envName !== "gamma", "org surfaces are gamma-only in this suite");
  const orgName = `${RUN_ID}-org2`;

  const createRes = await page.request.post(`${PROFILE}/api/orgs`, { data: { displayName: orgName } });
  test.skip(!createRes.ok(), `org creation not permitted here (HTTP ${createRes.status()})`);
  const org = (await listOrgs(page.request)).find((o) => o.displayName === orgName);
  expect(org).toBeTruthy();
  createdOrgIds.push(org!.orgId);

  try {
    await page.goto(`${PROFILE}/account/orgs/${encodeURIComponent(org!.orgId)}`, { waitUntil: "domcontentloaded" });
    // Owner/admin-only panel: heading, add/update form, and save button render.
    await expect(page.getByRole("heading", { name: "Organization API keys" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Add or update a key" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save key" })).toBeVisible();
    // Empty state (or an existing list panel) renders; we never add a real key.
    await expect(page.getByText("No org keys configured").or(page.getByText("Add or update a key")).first()).toBeVisible();
  } finally {
    await page.request.delete(`${PROFILE}/api/orgs/${encodeURIComponent(org!.orgId)}`).catch(() => {});
  }
});
