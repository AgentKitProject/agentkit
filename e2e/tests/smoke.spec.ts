import { test, expect } from "@playwright/test";
import { targets, catalogIsPublic, envName } from "../lib/targets";

// Unauthenticated smoke: every app is up, serves its own branded shell, the
// public catalog renders (prod — gamma's self-host catalog is login-gated), and
// auth-gated apps correctly bounce anonymous users to sign-in. These are the
// critical paths that must hold after every deploy; failure here is the
// auto-rollback trigger. Tests tagged @canary also run on the health cron.

test.describe("public app shells", () => {
  test("Profile home loads @canary", async ({ page }) => {
    const res = await page.goto(targets.profile, { waitUntil: "domcontentloaded" });
    expect(res?.status(), "profile HTTP status").toBeLessThan(400);
    await expect(page).toHaveTitle(/AgentKitProfile/);
  });

  test("Market home responds correctly for anonymous visitors @canary", async ({ page }) => {
    const res = await page.goto(targets.market, { waitUntil: "domcontentloaded" });
    expect(res?.status(), "market HTTP status").toBeLessThan(400);
    if (catalogIsPublic) {
      // Hosted prod: public catalog.
      await expect(page).toHaveTitle(/AgentKitMarket/);
      await expect(page.getByText(/Catalog|Browse Kits/i).first()).toBeVisible();
    } else {
      // Self-host gamma: REQUIRE_LOGIN — anonymous visits land on sign-in.
      await expect(page).toHaveURL(SIGN_IN);
    }
  });

  test("Market catalog route renders", async ({ page }) => {
    test.skip(!catalogIsPublic, "gamma catalog is login-gated");
    const res = await page.goto(`${targets.market}/kits`, { waitUntil: "domcontentloaded" });
    expect(res?.status(), "market /kits HTTP status").toBeLessThan(400);
  });
});

// Anonymous access to a protected app must land on the sign-in flow — either
// the app's own /auth/sign-in route or a generic OIDC authorize redirect
// (Keycloak & others expose /realms/<realm>/protocol/openid-connect/auth).
// Any counts as "auth enforced"; the app rendering its own content anonymously
// would NOT match and correctly fails the gate.
const SIGN_IN = /\/auth\/sign-in|authkit\.app|\/protocol\/openid-connect\/auth|\/realms\//;

test.describe("auth is enforced on protected apps", () => {
  test("Auto redirects anonymous users to sign-in", async ({ page }) => {
    await page.goto(targets.auto, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(SIGN_IN);
  });

  test("Forge redirects anonymous users to sign-in @canary", async ({ page }) => {
    await page.goto(targets.forge, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(SIGN_IN);
  });
});

test.describe("cross-app in-cluster health", () => {
  // The sign-in pages themselves must render (OIDC discovery reachable), not
  // 5xx — a common failure mode when an app boots without required env.
  test("Auto sign-in page renders @canary", async ({ request }) => {
    const res = await request.get(`${targets.auto}/auth/sign-in`);
    expect(res.status(), "auto sign-in status").toBeLessThan(400);
  });

  test("Keycloak realm discovery responds @canary", async ({ request }) => {
    const res = await request.get(
      `${targets.auth}/realms/agentkit/.well-known/openid-configuration`
    );
    expect(res.status(), "OIDC discovery status").toBe(200);
  });
});

// Deeper public journeys — real navigations an anonymous visitor makes. Kit slug
// is discovered at runtime from the catalog (never hardcoded) so it survives
// content churn; each self-skips if the anchor isn't present.
test.describe("public journeys", () => {
  test("a catalog kit opens its detail page", async ({ page }) => {
    test.skip(!catalogIsPublic, "gamma catalog is login-gated");
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
    test.skip(envName === "gamma" && !process.env.E2E_PUBLIC_HANDLE, "no public handle on gamma");
    const handle = process.env.E2E_PUBLIC_HANDLE ?? "jag8765";
    const res = await request.get(`${targets.profile}/u/${handle}`);
    test.skip(res.status() === 404, `no public profile for @${handle}`);
    expect(res.status(), "public profile status").toBeLessThan(400);
  });

  test("ecosystem site + docs are reachable @canary", async ({ request }) => {
    // Gamma has no site deployment — this always targets the hosted site.
    test.skip(envName === "gamma" && !process.env.E2E_SITE_URL, "no site on gamma");
    expect((await request.get(targets.site)).status(), "site apex").toBeLessThan(400);
    // Canonical docs path (bare /docs 301s through an http downgrade the client
    // may not follow; users land on /docs/).
    expect((await request.get(`${targets.site}/docs/`)).status(), "site /docs/").toBeLessThan(400);
  });
});
