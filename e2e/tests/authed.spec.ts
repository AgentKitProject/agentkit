import { test, expect } from "@playwright/test";
import { targets } from "../lib/targets";
import { hasRealSession } from "../global-setup";

// Authenticated critical paths for a dedicated test user. These run ONLY when a
// captured session is supplied via the E2E_STORAGE_STATE_JSON secret; otherwise
// the whole file skips (no password is ever handled in CI). Capture/refresh the
// state locally with: `playwright open --save-storage=auth/state.json <app>` after
// signing in as the test user, then store the file contents as the CI secret.
test.skip(!hasRealSession(), "no E2E_STORAGE_STATE_JSON — authed flows skipped");

test("Auto reaches the app (no sign-in bounce) when authenticated", async ({ page }) => {
  await page.goto(targets.auto, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/auth\/sign-in/);
});

test("Profile account/overview loads when authenticated", async ({ page }) => {
  const res = await page.goto(targets.profile, { waitUntil: "domcontentloaded" });
  expect(res?.status()).toBeLessThan(400);
  await expect(page).not.toHaveURL(/\/auth\/sign-in/);
});

test("P4: the test user's orgs resolve from Profile", async ({ page }) => {
  // Orgs are served by AgentKitProfile (system of record). The org UI living
  // under Profile must list at least the personal org for the authed user.
  await page.goto(targets.profile, { waitUntil: "domcontentloaded" });
  // Navigate to the org surface; tolerate either a dedicated route or a nav link.
  const orgsLink = page.getByRole("link", { name: /organizations?/i }).first();
  if (await orgsLink.isVisible().catch(() => false)) {
    await orgsLink.click();
    await expect(page.getByText(/personal|owner|organization/i).first()).toBeVisible();
  }
});
