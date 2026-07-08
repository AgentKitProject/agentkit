import { test, expect, type Page } from "@playwright/test";
import { targets, envName, RUN_ID } from "../../lib/targets";
import { STORAGE_STATE_PATH, hasRealSession } from "../../global-setup";

// CROSS-CUTTING UX + federated-auth CUJs: the shared @agentkitforge/ui chrome
// (Header/AppShell active-tab highlighting + the built-in ThemeToggle theme
// persistence) and the Keycloak Google identity-broker sign-in surface.
//
// NEWLY AUTHORED → every test is tagged @wip so it runs ONLY in the `wip`
// project (playwright.config.ts) and never gates a deploy (cuj / prod-cuj /
// canary all grepInvert @wip). Drop @wip once a test is shaken out on a live env.
//
// Tag rules honored:
//   - @reversible (prod-safe): the nav ACTIVE-TAB and THEME-persistence journeys
//     — both are read-only / client-localStorage-only. They create NO server
//     artifact, spend no money/compute, and the theme writes live in the
//     ephemeral per-test browser context (Playwright never writes them back to
//     the shared storageState), so they revert by construction.
//   - Google identity-broker sign-in is NOT @reversible: it is fundamentally an
//     OAuth-consent leg. The DRIVABLE extent (assert the broker button exists and
//     targets the Keycloak /broker/google/ endpoint on an anonymous login page)
//     is read-only and prod-safe, so it is deliberately NOT gamma-guarded — the
//     Google broker is a HOSTED-realm feature (chart default `google.enabled=false`,
//     so gamma self-host usually has no broker button; hosted prod's realm enables
//     it), and gamma-guarding a prod-only, read-only surface would make the test
//     assert nothing on either env. It self-skips where the broker isn't mounted.
//     The un-automatable external Google consent hop is always stubbed with a
//     reason (see the test). Being @wip, it never gates a deploy regardless.
//
// No RUN_ID-named artifacts are minted here — the journeys OBSERVE existing UI
// (nav/login chrome) or toggle ephemeral client theme, so there is nothing to
// prefix or sweep; the afterAll is a documented best-effort no-op (never throws).
//
// UI map (selectors/routes — read from the real source, not invented):
//   Shared chrome (packages/ui):
//     - AppShell sidebar (Forge/Auto/Market/Profile all render `layout="app"`):
//         primary nav container `nav.ak-sidebar__nav`; each item `.ak-nav-item`,
//         active → `.ak-nav-item--active` + `aria-current="page"` (SidebarItem in
//         components/AppShell.tsx). The cross-app switcher's current-app entry is
//         ALSO active but lives in a SEPARATE `.ak-sidebar__apps` block — so every
//         active-tab assertion is scoped to `.ak-sidebar__nav`.
//     - ThemeToggle (components/ThemeToggle.tsx via AppShell `themeToggle`): a
//         button with aria-label "Switch to light mode" / "Switch to dark mode".
//         useTheme (use-theme.ts) flips `data-theme` on <html> and persists to
//         localStorage key THEME_STORAGE_KEY = "akf-theme" (theme.ts); the FOUC-free
//         `themeInitScript()` in each app's app/layout.tsx re-reads that same key
//         pre-paint. localStorage is PER-ORIGIN (no cross-domain cookie) — the
//         "shared mechanism" is the common key + init script, verified below.
//   App nav labels (source): Forge apps/forge/app/forge/ForgeApp.tsx NAV — default
//     section "my-kits" → "My Kits"; Market apps/market-web/components/SiteChrome.tsx
//     ROUTE_TITLES — "/kits" → "Catalog", "/submit" → "Submit"; Auto
//     apps/auto-web/app/sections/section-ids.ts AUTO_SECTIONS — id "runs" → "History"
//     (deep-linked via `?section=runs`).
//   Keycloak sign-in (deploy/charts/agentkit-keycloak realm-configmap.yaml, standard
//     login theme): app GET /auth/sign-in → PKCE authorize → Keycloak login page
//     (`/realms/<realm>/protocol/openid-connect/auth`). Google broker button (when
//     realm `google.enabled`): `#social-google` <a> whose href targets the broker
//     login endpoint `/realms/<realm>/broker/google/login?...`.

test.skip(!hasRealSession(), "no E2E_USER/E2E_PASSWORD — CUJ suite skipped");

const FORGE = targets.forge.replace(/\/$/, "");
const MARKET = targets.market.replace(/\/$/, "");
const AUTO = targets.auto.replace(/\/$/, "");

// "The app (or Keycloak) is asking us to authenticate": the app's own sign-in
// route, or the Keycloak authorize/realm pages it forwards to.
const SIGN_IN = /\/auth\/sign-in|\/protocol\/openid-connect\/auth|\/realms\//;

const THEME_KEY = "akf-theme";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The current `data-theme` on <html> ("light" | "dark" | null). */
const getTheme = (page: Page) =>
  page.evaluate(() => document.documentElement.getAttribute("data-theme"));

/** The persisted shared-key value in this origin's localStorage. */
const getStoredTheme = (page: Page) =>
  page.evaluate((key) => localStorage.getItem(key), THEME_KEY);

/** The single built-in ThemeToggle button (nav variant) in the AppShell footer. */
const themeToggleButton = (page: Page) =>
  page.getByRole("button", { name: /Switch to (light|dark) mode/ }).first();

/**
 * Navigate to an authed app surface and assert the shared AppShell marks exactly
 * one PRIMARY-nav item active (scoped to `.ak-sidebar__nav`, so the app-switcher's
 * own active current-app entry in `.ak-sidebar__apps` is excluded), that it is the
 * expected tab, and that it carries `aria-current="page"`.
 */
async function assertActiveTab(page: Page, url: string, expectedLabel: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page, `authed session must reach ${url} without a sign-in bounce`).not.toHaveURL(SIGN_IN);

  const nav = page.locator("nav.ak-sidebar__nav");
  await expect(nav).toBeVisible({ timeout: 20_000 });

  const active = nav.locator(".ak-nav-item--active");
  // Exactly one active item in the primary nav (the current route/section).
  await expect(active).toHaveCount(1);
  await expect(active).toHaveAttribute("aria-current", "page");
  await expect(active).toContainText(expectedLabel);
}

// ---------------------------------------------------------------------------
// Best-effort cleanup: there is NOTHING persistent to sweep. Journeys 1–2 are
// read-only; journey 3's only writes are `akf-theme` in the ephemeral per-test
// browser context, which Playwright discards after the test and never persists to
// the shared storageState file. This afterAll exists per convention and never
// throws.
// ---------------------------------------------------------------------------

test.afterAll(async () => {
  // No server artifact, no RUN_ID object, no disk write-back to reconcile.
  return;
});

// ---------------------------------------------------------------------------
// 1. Google identity-broker SIGN-IN: on the Keycloak login page, the "Sign in
//    with Google" broker button is present and targets the Keycloak
//    /broker/google/ endpoint (identity brokering). The external Google consent
//    hop is un-automatable and is deliberately stubbed with a reason.
// ---------------------------------------------------------------------------

test("Google identity-broker button targets the Keycloak broker endpoint (consent hop stubbed) @wip", async ({
  browser
}, testInfo) => {
  // Fresh anonymous context (no storageState) so the Keycloak login page renders
  // for a genuinely signed-out visitor rather than silently SSO-ing through.
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    // App sign-in → PKCE authorize → Keycloak login page.
    await page.goto(`${FORGE}/auth/sign-in`, { waitUntil: "domcontentloaded" });
    await page
      .waitForURL(/\/realms\/|\/protocol\/openid-connect\/auth/, { timeout: 20_000 })
      .catch(() => undefined);

    // We must be on the Keycloak login surface (the app forwarded us to the IdP).
    test.skip(
      !SIGN_IN.test(page.url()),
      `did not reach the Keycloak login page (landed on ${page.url()}) — cannot inspect the broker button`
    );

    // The standard Keycloak login theme renders social providers as
    // `<a id="social-google" href=".../broker/google/login?...">`. Match tolerantly
    // (id, broker-href, or an accessible "Google" link) so a lightly-customized
    // theme still resolves.
    const googleButton = page
      .locator("#social-google")
      .or(page.locator("a[href*='/broker/google/']"))
      .or(page.locator("a[href*='kc_idp_hint=google']"))
      .or(page.getByRole("link", { name: /google/i }))
      .first();

    const present = await googleButton.isVisible().catch(() => false);
    test.skip(
      !present,
      `env=${envName}: no Google identity-broker button on this realm's login page. The broker is a HOSTED-realm ` +
        "feature (agentkit-keycloak chart default `google.enabled=false`; hosted prod's realm enables it), so a " +
        "self-host / gamma login page typically has no social button to assert."
    );

    // The button links to the Keycloak identity-broker login endpoint — NOT a raw
    // accounts.google.com URL — i.e. Keycloak owns the brokered hop.
    const href = (await googleButton.getAttribute("href")) ?? "";
    const resolved = new URL(href, page.url());
    expect(resolved.pathname, "broker link hits the Keycloak /broker/google/ endpoint").toContain(
      "/broker/google/"
    );
    expect(
      resolved.origin,
      "the broker endpoint is same-origin as the Keycloak issuer (brokered by Keycloak, not a direct Google link)"
    ).toBe(new URL(page.url()).origin);

    // The external Google consent screen is un-automatable (real Google login +
    // consent). Stop at the broker handoff and document the remainder.
    testInfo.annotations.push({
      type: "note",
      description:
        "External hop STUBBED: clicking the broker button redirects to accounts.google.com for real Google login + " +
        "consent, which cannot be driven in CI (no scriptable Google credential / consent). Coverage stops at the " +
        "verified Keycloak /broker/google/ handoff. To exercise the full brokered login end-to-end, seed a test " +
        "Google identity and complete consent out-of-band, or mock the upstream IdP."
    });
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Nav ACTIVE-TAB highlighting across the ecosystem (Market, Forge, Auto): the
//    current route/section's shared-AppShell nav item carries the active state
//    (aria-current="page" + `.ak-nav-item--active`), and a non-current item does
//    not. Read-only → @reversible.
// ---------------------------------------------------------------------------

test("shared nav highlights the active tab on Market, Forge, and Auto @wip @reversible", async ({
  page
}, testInfo) => {
  testInfo.annotations.push({
    type: "note",
    description: `run ${RUN_ID}: active-tab assertions are read-only navigations (no artifacts created).`
  });

  // Market — href-based active from the pathname: /kits → "Catalog".
  await assertActiveTab(page, `${MARKET}/kits`, "Catalog");
  // …and a sibling non-current tab ("Submit") is NOT marked active.
  const marketSubmit = page
    .locator("nav.ak-sidebar__nav")
    .getByRole("link", { name: "Submit", exact: true });
  await expect(marketSubmit).toBeVisible();
  await expect(marketSubmit).not.toHaveAttribute("aria-current", "page");

  // Forge — SPA section state: /forge defaults to the "my-kits" section → "My Kits".
  await assertActiveTab(page, `${FORGE}/forge`, "My Kits");

  // Auto — SPA section deep-linked from ?section=: "runs" → the "History" tab.
  await assertActiveTab(page, `${AUTO}/?section=runs`, "History");
});

// ---------------------------------------------------------------------------
// 3. THEME persistence: the built-in ThemeToggle flips `data-theme` + persists to
//    the shared `akf-theme` localStorage key; it survives a reload (same-origin),
//    and the SAME shared key drives the theme identically in a second app
//    (Forge → Market). Client-localStorage only → @reversible.
// ---------------------------------------------------------------------------

test("theme toggle persists across a reload and the shared akf-theme key drives a second app @wip @reversible", async ({
  page
}, testInfo) => {
  // --- Forge: toggle → data-theme flips + persists to the shared key. ---
  await page.goto(`${FORGE}/forge`, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(SIGN_IN);

  const toggle = themeToggleButton(page);
  await expect(toggle).toBeVisible({ timeout: 20_000 });

  const before = await getTheme(page); // "light" | "dark" (themeInitScript always sets one)
  await toggle.click();

  // The attribute flipped to the other theme…
  await expect.poll(() => getTheme(page), { timeout: 10_000 }).not.toBe(before);
  const toggled = (await getTheme(page)) as "light" | "dark";
  expect(["light", "dark"]).toContain(toggled);
  // …and the choice persisted under the shared key.
  await expect.poll(() => getStoredTheme(page), { timeout: 5_000 }).toBe(toggled);

  // Same-origin persistence: a full reload keeps the toggled theme (the pre-paint
  // themeInitScript re-reads `akf-theme`).
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => getTheme(page), { timeout: 10_000 }).toBe(toggled);
  expect(await getStoredTheme(page)).toBe(toggled);

  // --- Cross-app: the SAME shared key drives Market identically. ---
  // localStorage is per-ORIGIN and there is no cross-domain theme cookie in the
  // source, so navigating Forge → Market does not auto-carry the choice. The
  // "shared mechanism" is that EVERY app reads the identical `akf-theme` key via
  // the identical `themeInitScript`. Demonstrate that by handing the key across:
  // seed Market's origin with the same value, then assert Market's pre-paint init
  // applies it.
  await page.goto(`${MARKET}/kits`, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(SIGN_IN);
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [THEME_KEY, toggled] as const);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect
    .poll(() => getTheme(page), { timeout: 10_000 })
    .toBe(toggled); // Market honors the shared key via its own themeInitScript

  // Market also ships the same real toggle, so a user can flip it there too.
  await expect(themeToggleButton(page)).toBeVisible({ timeout: 20_000 });

  testInfo.annotations.push({
    type: "note",
    description:
      "localStorage is per-origin and the source has NO cross-domain theme cookie, so a Forge→Market navigation " +
      "does not itself carry the theme. The 'shared mechanism' asserted here is the common `akf-theme` key + " +
      "`themeInitScript` that each app implements identically (Forge persist-across-reload proven directly; the " +
      "Market handoff proven by seeding the same key and observing its pre-paint init apply it). A true one-navigation " +
      "cross-app carry would require a shared `.agentkitproject.com` theme cookie, which does not exist today."
  });
});
