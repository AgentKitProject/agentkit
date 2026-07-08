import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { targets, envName, RUN_ID } from "../../lib/targets";
import { STORAGE_STATE_PATH, hasRealSession } from "../../global-setup";
import { kcLogin, loginAllApps } from "../../lib/auth";

// Cross-cutting AUTH critical-user-journeys (Keycloak OIDC + iron-session).
// NEWLY AUTHORED → every test is tagged @wip so it runs ONLY in the `wip`
// project and never gates a deploy until it's been shaken out on a live env.
// Tests additionally tagged @reversible are prod-safe (read-only session
// checks — no writes, no money, no artifacts); the SIGN-OUT journey is
// gamma-guarded because it performs an RP-initiated Keycloak logout that
// invalidates the SHARED server-side SSO session (see its note).
//
// These journeys create NO persistent server artifacts (no kits/orgs/
// submissions) — the only "state" is the auth session. There is therefore
// nothing RUN_ID-prefixed to sweep; the afterAll instead best-effort REVIVES
// the shared Keycloak session on gamma (the sign-out test destroys it).
//
// UI map (routes/selectors — read from app source, not invented):
//   Auth routes (all apps, apps/*/app/auth/*/route.ts → lib/auth-provider/oidc-provider.ts):
//     - GET /auth/sign-in  → PKCE authorize redirect to the Keycloak issuer.
//     - GET /auth/callback → code exchange → seals iron-session → app home.
//     - GET /auth/sign-out → destroys iron-session; if the issuer advertises an
//       end_session_endpoint, RP-initiated logout (id_token_hint +
//       post_logout_redirect_uri = app home).
//   returnTo (apps/market-web/app/{submit,submissions}/page.tsx, require-login.ts):
//     - anon GET /submit → redirect /auth/sign-in?returnTo=%2Fsubmit (page-level
//       on hosted prod; middleware require-login gate on self-host gamma — same
//       Location either way). NOTE: only Profile's OIDC provider consumes
//       returnTo end-to-end; market/auto/forge callbacks discard it → app home.
//   Authed app content (post-login landing surfaces):
//     - Forge (apps/forge/app/forge/ForgeApp.tsx): sidebar button "My Kits".
//     - Auto  (apps/auto-web): run console shows "Start a run".
//     - Market (apps/market-web/components/SiteChrome.tsx): tabs "My Submissions"/"Purchases".
//   Login form is driven by lib/auth.ts::kcLogin (#username / #password / #kc-login).

test.skip(!hasRealSession(), "no E2E_USER/E2E_PASSWORD — CUJ suite skipped");

const FORGE = targets.forge.replace(/\/$/, "");
const AUTO = targets.auto.replace(/\/$/, "");
const MARKET = targets.market.replace(/\/$/, "");

// Any of these in the final URL means "the app challenged for auth": the app's
// own /auth/sign-in route, or the Keycloak authorize page it forwards to.
const SIGN_IN = /\/auth\/sign-in|\/protocol\/openid-connect\/auth|\/realms\//;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Assert an app admitted the signed-in user: it did NOT bounce to sign-in and
 *  the given authed-content locator resolved. */
async function assertAdmitted(page: Page, url: string, content: () => Promise<void>): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(SIGN_IN);
  await content();
}

const forgeAdmitted = (page: Page) =>
  assertAdmitted(page, `${FORGE}/forge`, () =>
    expect(page.getByRole("button", { name: "My Kits", exact: true })).toBeVisible({
      timeout: 20_000
    })
  );

const autoAdmitted = (page: Page) =>
  assertAdmitted(page, AUTO, () =>
    expect(page.getByText("Start a run").first()).toBeVisible({ timeout: 20_000 })
  );

const marketAdmitted = (page: Page) =>
  assertAdmitted(page, MARKET, () =>
    expect(page.getByText(/My Submissions|Purchases/i).first()).toBeVisible({ timeout: 20_000 })
  );

// ---------------------------------------------------------------------------
// Failure-tolerant "cleanup": no persistent artifacts are created here. On
// gamma, the sign-out journey destroys the shared server-side Keycloak session;
// revive it (best-effort, throwaway context) so later gamma tests can still SSO.
// ---------------------------------------------------------------------------

test.afterAll(async ({ browser }) => {
  if (!hasRealSession() || envName !== "gamma") return;
  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext();
    await loginAllApps(context); // re-establishes a live Keycloak SSO session
  } catch {
    // best-effort session revival — never fail the suite here
  } finally {
    await context?.close();
  }
});

// ---------------------------------------------------------------------------
// 1. Real Keycloak SIGN-IN driven as a CUJ (fresh anonymous context).
// Reuses lib/auth.ts::kcLogin — the exact form-login the suite bootstraps with —
// so this asserts the whole authorize → form → OIDC callback → app-content path.
// ---------------------------------------------------------------------------

test("real Keycloak form sign-in lands on authed app content @reversible @wip", async ({
  browser
}) => {
  // Fresh context = NO storageState = genuinely anonymous → the Keycloak form
  // renders and kcLogin submits E2E_USER/E2E_PASSWORD.
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await kcLogin(page, FORGE);
    // Back on the app origin, not still on the IdP.
    await expect(page).not.toHaveURL(SIGN_IN);
    // The sealed iron-session admits us to protected app content.
    await forgeAdmitted(page);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Cross-app silent SSO: with the shared session, one context reaches Forge,
// Auto, and Market with no re-auth. (The shared storageState was itself built by
// loginAllApps, where apps 2..n are silent SSO off the Keycloak cookie.)
// ---------------------------------------------------------------------------

test("cross-app silent SSO: Forge → Auto → Market, no re-challenge @reversible @wip", async ({
  page
}) => {
  await forgeAdmitted(page);
  await autoAdmitted(page);
  await marketAdmitted(page);
});

// ---------------------------------------------------------------------------
// 3. Session persistence across a full page reload.
// ---------------------------------------------------------------------------

test("authed session survives a page reload @reversible @wip", async ({ page }) => {
  await forgeAdmitted(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(SIGN_IN);
  await expect(page.getByRole("button", { name: "My Kits", exact: true })).toBeVisible({
    timeout: 20_000
  });
});

// ---------------------------------------------------------------------------
// 4. Anonymous returnTo round-trip: a protected deep link bounces an anon user
// to sign-in carrying returnTo=<path>.
//
// WITHOUT real creds in-test we assert exactly the deterministic first hop —
// the page-level (prod) / require-login (gamma) redirect to
// /auth/sign-in?returnTo=<encoded deep link>. Completing the round-trip (login
// → land back ON the deep link) is app-specific: only Profile's OIDC provider
// packs returnTo into the auth transaction and honors it at callback;
// market/forge/auto callbacks redirect to app home and DISCARD returnTo. So the
// carried-returnTo hop is the strongest cross-app assertion available here.
// ---------------------------------------------------------------------------

test("anonymous deep link redirects to sign-in with returnTo @reversible @wip", async ({
  browser
}) => {
  const context = await browser.newContext(); // anonymous (no storageState)
  try {
    // (a) Deterministic, creds-free: read the raw redirect Location (don't
    //     follow it) and assert it targets sign-in carrying our deep-link path.
    const res = await context.request.get(`${MARKET}/submit`, { maxRedirects: 0 });
    expect(
      res.status(),
      `anon GET /submit should redirect (3xx), got ${res.status()}`
    ).toBeGreaterThanOrEqual(300);
    expect(res.status()).toBeLessThan(400);
    const location = res.headers()["location"] ?? "";
    expect(location, "redirect Location targets the sign-in route").toContain("/auth/sign-in");
    const returnTo = new URL(location, MARKET).searchParams.get("returnTo");
    expect(returnTo, "sign-in carries a returnTo for the requested deep link").toBe("/submit");

    // (b) Real navigation: following the chain lands on the sign-in flow (the
    //     app's /auth/sign-in or the Keycloak authorize page it forwards to).
    const page = await context.newPage();
    await page.goto(`${MARKET}/submit`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(SIGN_IN);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// 5. GAMMA-ONLY: SIGN-OUT destroys the session and re-challenges protected apps.
// Gamma-guarded because /auth/sign-out performs an RP-initiated Keycloak logout
// that invalidates the user's SHARED server-side SSO session (not just this
// context's cookie). Run in an ISOLATED context cloned from the shared
// storageState so the state.json file is never mutated, and immediately
// re-login inside it (plus the afterAll revival) so the rest of the gamma run
// can still SSO. NOT @reversible — never let this touch prod.
// ---------------------------------------------------------------------------

test("sign-out destroys the session and re-challenges (gamma only) @wip", async ({ browser }) => {
  test.skip(
    envName !== "gamma",
    "gamma-only: sign-out RP-invalidates the shared Keycloak SSO session — never on prod"
  );

  const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
  try {
    const page = await context.newPage();

    // Precondition: this cloned session is authed.
    await forgeAdmitted(page);

    // Trigger sign-out. The route destroys the iron-session then (if advertised)
    // RP-logs-out at Keycloak and post-logout-redirects back to the app home.
    await page.goto(`${FORGE}/auth/sign-out`, { waitUntil: "domcontentloaded" });

    // Session destroyed: a protected route now re-challenges (sign-in flow).
    await page.goto(`${FORGE}/forge`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(SIGN_IN, { timeout: 20_000 });

    // Re-establish immediately so the shared Keycloak session is live again for
    // the remainder of this gamma run (belt-and-braces with the afterAll).
    await kcLogin(page, FORGE);
    await expect(page).not.toHaveURL(SIGN_IN);
  } finally {
    await context.close();
  }
});
