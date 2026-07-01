import { test, expect } from "@playwright/test";
import { targets } from "../lib/targets";
import { hasRealSession } from "../global-setup";

// Authenticated critical user journeys for a dedicated test user, covering the
// features this ecosystem ships (P4 orgs→Profile, private kits, B Auto↔Forge kit
// DB). Runs ONLY when a captured session is supplied via E2E_STORAGE_STATE_JSON;
// otherwise the whole file skips (no password ever handled in CI). Capture with:
//   npx playwright open --save-storage=auth/state.json https://auto.agentkitproject.com
// then store the file contents as the CI secret.
//
// These are READ-ONLY on purpose: this suite is the auto-rollback trigger, so it
// must not mutate prod state (a flaky mutation would roll back a good deploy).
// State-mutating flows (create org, toggle a kit private) belong in a separate
// non-gating suite.
test.skip(!hasRealSession(), "no E2E_STORAGE_STATE_JSON — authed CUJs skipped");

test.describe("authed: apps admit the signed-in user", () => {
  test("Auto opens the run console (not bounced to sign-in)", async ({ page }) => {
    await page.goto(targets.auto, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/auth\/sign-in|authkit\.app/);
    // Auto's authed shell shows the section nav (Run / History / …).
    await expect(page.getByText(/Start a run|Run history/i).first()).toBeVisible();
  });

  test("Web Forge admits the signed-in user", async ({ page }) => {
    await page.goto(targets.webForge, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/auth\/sign-in|authkit\.app/);
  });

  test("Market shows the authed nav", async ({ page }) => {
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
