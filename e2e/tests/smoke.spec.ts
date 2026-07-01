import { test, expect } from "@playwright/test";
import { targets } from "../lib/targets";

// Unauthenticated smoke: every hosted app is up, serves its own branded shell,
// public catalog renders, and auth-gated apps correctly bounce anonymous users
// to sign-in. These are the critical paths that must hold after every deploy;
// failure here is the auto-rollback trigger.

test.describe("public app shells", () => {
  test("Profile home loads", async ({ page }) => {
    const res = await page.goto(targets.profile, { waitUntil: "domcontentloaded" });
    expect(res?.status(), "profile HTTP status").toBeLessThan(400);
    await expect(page).toHaveTitle(/AgentKitProfile/);
  });

  test("Market home loads with catalog", async ({ page }) => {
    const res = await page.goto(targets.market, { waitUntil: "domcontentloaded" });
    expect(res?.status(), "market HTTP status").toBeLessThan(400);
    await expect(page).toHaveTitle(/AgentKitMarket/);
    await expect(page.getByText(/Catalog|Browse Kits/i).first()).toBeVisible();
  });

  test("Market catalog route renders", async ({ page }) => {
    const res = await page.goto(`${targets.market}/kits`, { waitUntil: "domcontentloaded" });
    expect(res?.status(), "market /kits HTTP status").toBeLessThan(400);
  });

  // NOTE: the "Forge (desktop) home loads" check was removed when the desktop app
  // was retired — forge.agentkitproject.com now 301-redirects to web Forge, which
  // is covered by the "Web Forge redirects anonymous users to sign-in" test below.
  // TODO: add a proper web-Forge home/redirect assertion when we revisit the suite.
});

// Anonymous access to a protected app must land on the sign-in flow — either the
// app's own /auth/sign-in route or (after WorkOS AuthKit hands off) the hosted
// authkit.app login. Either counts as "auth enforced"; the app rendering its own
// content anonymously would NOT match and correctly fails the gate.
// IdP-agnostic: the app's own /auth/sign-in route, WorkOS AuthKit (authkit.app),
// or a generic OIDC authorize redirect (Keycloak & others expose
// /realms/<realm>/protocol/openid-connect/auth). Any counts as "auth enforced".
const SIGN_IN = /\/auth\/sign-in|authkit\.app|\/protocol\/openid-connect\/auth|\/realms\//;

test.describe("auth is enforced on protected apps", () => {
  test("Auto redirects anonymous users to sign-in", async ({ page }) => {
    await page.goto(targets.auto, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(SIGN_IN);
  });

  test("Web Forge redirects anonymous users to sign-in", async ({ page }) => {
    await page.goto(targets.webForge, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(SIGN_IN);
  });
});

test.describe("cross-app in-cluster health", () => {
  // The auto/web-forge sign-in pages themselves must render (WorkOS AuthKit up),
  // not 5xx — a common failure mode when an app boots without required env.
  test("Auto sign-in page renders", async ({ request }) => {
    const res = await request.get(`${targets.auto}/auth/sign-in`);
    expect(res.status(), "auto sign-in status").toBeLessThan(400);
  });
});

// Deeper public journeys — real navigations an anonymous visitor makes. Kit slug
// is discovered at runtime from the catalog (never hardcoded) so it survives
// content churn; each self-skips if the anchor isn't present.
test.describe("public journeys", () => {
  test("a catalog kit opens its detail page", async ({ page }) => {
    await page.goto(`${targets.market}/kits`, { waitUntil: "networkidle" });
    // Kit cards navigate via the router, so the slug lives in the rendered
    // payload rather than an <a href>. Discover one from the page content.
    const html = await page.content();
    const match = html.match(/\/kits\/([a-z0-9][a-z0-9-]{6,})/i);
    test.skip(!match, "no public kits in catalog");
    const res = await page.goto(`${targets.market}${match![0]}`, { waitUntil: "domcontentloaded" });
    expect(res?.status(), "kit detail status").toBeLessThan(400);
    await expect(page).toHaveTitle(/AgentKitMarket/);
  });

  test("a public profile page renders", async ({ request }) => {
    const handle = process.env.E2E_PUBLIC_HANDLE ?? "jag8765";
    const res = await request.get(`${targets.profile}/u/${handle}`);
    test.skip(res.status() === 404, `no public profile for @${handle}`);
    expect(res.status(), "public profile status").toBeLessThan(400);
  });

  test("ecosystem site + docs are reachable", async ({ request }) => {
    const site = process.env.E2E_SITE_URL ?? "https://agentkitproject.com";
    expect((await request.get(site)).status(), "site apex").toBeLessThan(400);
    // Canonical docs path (bare /docs 301s through an http downgrade the client
    // may not follow; users land on /docs/).
    expect((await request.get(`${site}/docs/`)).status(), "site /docs/").toBeLessThan(400);
  });
});
