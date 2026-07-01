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

  test("Forge (desktop) home loads", async ({ page }) => {
    const res = await page.goto(targets.forge, { waitUntil: "domcontentloaded" });
    expect(res?.status(), "forge HTTP status").toBeLessThan(400);
    await expect(page).toHaveTitle(/AgentKitForge/);
  });
});

// Anonymous access to a protected app must land on the sign-in flow — either the
// app's own /auth/sign-in route or (after WorkOS AuthKit hands off) the hosted
// authkit.app login. Either counts as "auth enforced"; the app rendering its own
// content anonymously would NOT match and correctly fails the gate.
const SIGN_IN = /\/auth\/sign-in|authkit\.app/;

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
