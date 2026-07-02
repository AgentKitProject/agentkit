import { test, expect, type Page } from "@playwright/test";
import { targets, envName, RUN_ID } from "../../lib/targets";
import { STORAGE_STATE_PATH, hasRealSession } from "../../global-setup";

// Forge web-app CUJs (apps/forge). Runs in the `cuj` project (serial, authed
// storageState). Tests tagged @reversible also run in `prod-cuj`: they only
// create/delete RUN_ID-prefixed kits in the user's own server-side library
// (KitStore) — reversible, zero LLM spend, no purchases. Untagged tests are
// gamma-only (the run-dispatch journey intentionally exercises a FAILING AI
// call against gamma's placeholder Anthropic key).
//
// UI map (apps/forge/app/forge/ForgeApp.tsx + sections/*):
//   - sidebar nav buttons: "My Kits" / "Build" / "Import" / "Package / Export"
//     / "Run / Chat" … ; deep links: ?section=<id>, ?kit=market:<slug>.
//   - kit cards: article.kit-library-card with "Open/Package/Remove" buttons.
//   - toasts: .akf-toast (error variant .akf-toast.err), visible ~4.2s.
//   - form fields: .ak-field > label (no htmlFor) + input/textarea/select.

const FIXTURE_ZIP = "fixtures/e2e-fixture-kit.agentkit.zip";
const FIXTURE_KIT_NAME = "E2E Fixture Kit"; // name inside the fixture manifest

test.skip(!hasRealSession(), "no E2E_USER/E2E_PASSWORD — CUJ suite skipped");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Open the Forge shell and wait for it to hydrate (sidebar nav present). */
async function gotoForge(page: Page, query = ""): Promise<void> {
  await page.goto(`${targets.forge}/forge${query}`, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/openid-connect|\/auth\/sign-in/);
  await expect(page.getByRole("button", { name: "My Kits", exact: true })).toBeVisible({
    timeout: 20_000
  });
}

/** Click a sidebar nav entry (buttons rendered by the shared AppShell). */
async function navTo(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: label, exact: true }).click();
}

/** The input/textarea/select of a labelled `.ak-field` (labels lack htmlFor). */
function fieldControl(page: Page, label: string) {
  return page
    .locator(".ak-field")
    .filter({ has: page.locator(`label:text-is("${label}")`) })
    .locator("input, textarea, select")
    .first();
}

/** Kit cards in My Kits whose text contains `name` (owned list only —
 *  favorite cards have no "Remove" button so removal never touches them). */
function kitCards(page: Page, name: string | RegExp) {
  return page.locator("article.kit-library-card").filter({ hasText: name });
}

/** Wait for the My Kits surface (toolbar always renders the counts line). */
async function expectMyKitsSurface(page: Page): Promise<void> {
  await expect(page.getByText(/owned \(built & imported\)/).first()).toBeVisible({
    timeout: 20_000
  });
}

/** From anywhere in the shell: go to My Kits and remove every owned kit card
 *  matching `name`. Tolerant — used for pre-clean and afterAll sweeps. */
async function removeMatchingKits(page: Page, name: string | RegExp): Promise<void> {
  await navTo(page, "My Kits");
  await expectMyKitsSurface(page);
  // Let the async kit-list fetch settle before counting.
  await page.waitForTimeout(1_000);
  const cards = kitCards(page, name);
  for (let i = 0; i < 15; i++) {
    const count = await cards.count();
    if (count === 0) break;
    const removeBtn = cards.first().getByRole("button", { name: "Remove", exact: true });
    if (!(await removeBtn.isVisible().catch(() => false))) break; // favorite-only match
    await removeBtn.click();
    await expect(cards).toHaveCount(count - 1, { timeout: 20_000 });
  }
}

/** Create a kit via Build → "From template" (blank). Lands in the Kit editor. */
async function createTemplateKit(page: Page, idAndName: string): Promise<void> {
  await navTo(page, "Build");
  await page.getByRole("tab", { name: "From template" }).click();
  await fieldControl(page, "Kit id (slug)").fill(idAndName);
  await fieldControl(page, "Name").fill(idAndName);
  await fieldControl(page, "Description").fill(`Disposable E2E kit ${idAndName}. Safe to delete.`);
  await page.getByRole("button", { name: "Create kit", exact: true }).click();
  // Success opens the kit editor (topbar title flips to "Kit editor").
  await expect(page.getByText("Kit editor").first()).toBeVisible({ timeout: 30_000 });
}

/** Remove a single kit by name and assert it is gone from My Kits. */
async function deleteKit(page: Page, name: string): Promise<void> {
  await navTo(page, "My Kits");
  await expectMyKitsSurface(page);
  const card = kitCards(page, name);
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await card.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(card).toHaveCount(0, { timeout: 20_000 });
}

// ---------------------------------------------------------------------------
// journeys
// ---------------------------------------------------------------------------

test.describe("CUJ — Forge web app", () => {
  // Tolerant final sweep: whatever a failed iteration left behind, remove it.
  test.afterAll(async ({ browser }) => {
    if (!hasRealSession()) return;
    const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
    const page = await context.newPage();
    try {
      await gotoForge(page);
      await removeMatchingKits(page, new RegExp(`${RUN_ID}|${FIXTURE_KIT_NAME}`));
    } catch {
      // best-effort cleanup — never fail the suite here
    } finally {
      await context.close();
    }
  });

  test("My Kits renders for the signed-in user @reversible", async ({ page }) => {
    await gotoForge(page);
    // Landing section is My Kits; the toolbar counts line always renders.
    await expectMyKitsSurface(page);
    // Either the empty state or at least one kit card is an acceptable surface.
    const emptyState = page.getByText("No kits yet");
    const anyCard = page.locator("article.kit-library-card").first();
    await expect(emptyState.or(anyCard).first()).toBeVisible({ timeout: 20_000 });
  });

  test("create kit from template → listed in My Kits → delete @reversible", async ({ page }) => {
    const kitName = `${RUN_ID}-kit`;
    await gotoForge(page);
    await removeMatchingKits(page, kitName); // retry-safe pre-clean
    await createTemplateKit(page, kitName);
    // Back to My Kits (clears the open editor) — the new kit must be listed.
    await navTo(page, "My Kits");
    await expectMyKitsSurface(page);
    await expect(kitCards(page, kitName)).toHaveCount(1, { timeout: 20_000 });
    // Delete it and verify it is gone.
    await deleteKit(page, kitName);
  });

  test("import fixture .agentkit.zip → kit appears → delete @reversible", async ({ page }) => {
    await gotoForge(page);
    await removeMatchingKits(page, FIXTURE_KIT_NAME); // leftovers from prior runs
    await navTo(page, "Import");
    // Default tab is "Upload .agentkit.zip" with a bare file input.
    await expect(page.getByRole("tab", { name: "Upload .agentkit.zip" })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles(FIXTURE_ZIP);
    await page.getByRole("button", { name: "Import zip", exact: true }).click();
    // Success lands in My Kits and auto-opens the imported kit in the editor.
    await expect(page.getByText("Kit editor").first()).toBeVisible({ timeout: 45_000 });
    await navTo(page, "My Kits");
    await expectMyKitsSurface(page);
    await expect(kitCards(page, FIXTURE_KIT_NAME)).toHaveCount(1, { timeout: 20_000 });
    await deleteKit(page, FIXTURE_KIT_NAME);
  });

  test("package a kit downloads an .agentkit.zip @reversible", async ({ page }) => {
    const kitName = `${RUN_ID}-pkg`;
    await gotoForge(page);
    await removeMatchingKits(page, kitName);
    await createTemplateKit(page, kitName);
    // Package via the dedicated Package / Export section.
    await navTo(page, "Package / Export");
    await fieldControl(page, "Kit").selectOption({ label: kitName });
    const downloadPromise = page.waitForEvent("download", { timeout: 45_000 });
    await page.getByRole("button", { name: "Download package", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.zip$/);
    // Success toast confirms the client finished the package flow.
    await expect(page.locator(".akf-toast", { hasText: "Package downloaded" })).toBeVisible({
      timeout: 15_000
    });
    await deleteKit(page, kitName);
  });

  // Untagged (gamma-only): depends on the Market catalog having published kits.
  test("market deep link ?kit=market:<slug> routes to Run / Chat", async ({ page }) => {
    await gotoForge(page); // establishes the authed session for the API probe
    // Discover a published slug via Forge's own catalog proxy (authed cookies).
    const res = await page.request.get(`${targets.forge}/api/market/catalog?limit=5`);
    test.skip(!res.ok(), `catalog probe failed (${res.status()}) — no slug to deep-link`);
    const body = (await res.json()) as { kits?: { slug?: string }[] };
    const slug = body.kits?.find((k) => k.slug)?.slug;
    test.skip(!slug, "no published Market kits on this environment — nothing to deep-link");

    await gotoForge(page, `?kit=market:${slug}`);
    // The deep link must land on the Run / Chat surface — not crash the shell.
    await expect(page.getByRole("heading", { name: /chat with a kit/i }).first()).toBeVisible({
      timeout: 20_000
    });
    await expect(fieldControl(page, "Kit")).toBeVisible();
  });

  // Untagged = gamma-only. Gamma's ANTHROPIC key is a placeholder, so the run
  // MUST fail at the AI API — we assert the app surfaces that failure
  // gracefully (error toast / inline warning, shell intact), never completion.
  test("run dispatch surfaces the AI failure gracefully", async ({ page }) => {
    test.skip(envName !== "gamma", "run dispatch is gamma-only (never spend on prod)");
    const kitName = `${RUN_ID}-run`;
    await gotoForge(page);
    await removeMatchingKits(page, kitName);
    await createTemplateKit(page, kitName);

    await navTo(page, "Run / Chat");
    await expect(page.getByRole("heading", { name: /chat with a kit/i }).first()).toBeVisible();
    await fieldControl(page, "Kit").selectOption({ label: kitName });
    await fieldControl(page, "Message").fill("Say hello. (E2E dispatch check — expected to fail)");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    // The failure must SURFACE: error toast or inline credits/warning banner.
    await expect(page.locator(".akf-toast.err, .inline-warning").first()).toBeVisible({
      timeout: 60_000
    });
    // …and the shell must survive (no blank crash): the Run surface is intact.
    await expect(page.getByRole("heading", { name: /chat with a kit/i }).first()).toBeVisible();

    await deleteKit(page, kitName);
  });
});
