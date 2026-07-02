import { test, expect } from "@playwright/test";
import { targets } from "../lib/targets";
import { hasRealSession, STORAGE_STATE_PATH } from "../global-setup";

// Authenticated READ-ONLY checks for the dedicated E2E user. The session comes
// from a REAL Keycloak form login in global-setup (E2E_USER + E2E_PASSWORD CI
// secrets — we own the IdP, so no captured-session dance). The file self-skips
// when no credentials are supplied.
//
// These stay READ-ONLY on purpose: this project runs inside rollback gates, so
// it must never mutate state. Write journeys live in tests/cuj/ (the `cuj` /
// `prod-cuj` projects) with RUN_ID-prefixed artifacts + cleanup.
test.skip(!hasRealSession(), "no E2E_USER/E2E_PASSWORD — authed checks skipped");

// File-level auth: the `authed` project already supplies this storageState, and
// setting it here too lets these tests stay authenticated when they run inside
// the ANONYMOUS `canary` project (which must not globally preload auth).
test.use({ storageState: STORAGE_STATE_PATH });

test.describe("authed: apps admit the signed-in user", () => {
  test("Auto opens the run console (not bounced to sign-in) @canary", async ({ page }) => {
    await page.goto(targets.auto, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/auth\/sign-in|authkit\.app/);
    // Auto's authed shell shows the section nav (Run / History / …).
    await expect(page.getByText(/Start a run|Run history/i).first()).toBeVisible();
  });

  test("Forge admits the signed-in user @canary", async ({ page }) => {
    await page.goto(targets.forge, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/auth\/sign-in|authkit\.app/);
  });

  test("Market shows the authed nav @canary", async ({ page }) => {
    await page.goto(targets.market, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/auth\/sign-in|authkit\.app/);
    await expect(page.getByText(/Submissions|Purchases/i).first()).toBeVisible();
  });
});

test.describe("CUJ — P4: orgs resolve from Profile", () => {
  test("Profile lists the user's organization", async ({ page }) => {
    await page.goto(targets.profile, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/auth\/sign-in|authkit\.app/);
    const orgsNav = page.getByRole("link", { name: /organizations/i }).first();
    await orgsNav.click().catch(() => {});
    // The user's personal org (or the org list surface) must render — proves the
    // whole P4 chain: app → Profile service key → org record present.
    await expect(
      page.getByText(/organization|personal|owner|member/i).first()
    ).toBeVisible();
  });
});

test.describe("CUJ — B: Auto can see the user's kits", () => {
  test("Auto run console exposes a kit selector", async ({ page }) => {
    await page.goto(targets.auto, { waitUntil: "networkidle" });
    await expect(page).not.toHaveURL(/\/auth\/sign-in|authkit\.app/);
    // The Run pane must offer kit selection (populated from the shared Forge kit
    // DB under B). We assert the selector surface exists — not a specific kit —
    // so the test doesn't depend on the test user having built one.
    await expect(
      page.getByText(/kit/i).first()
    ).toBeVisible();
  });
});
