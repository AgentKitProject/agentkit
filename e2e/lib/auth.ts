import type { BrowserContext, Page } from "@playwright/test";
import { targets } from "./targets";

// Real Keycloak form login for the dedicated E2E user (seeded in both realms).
// Credentials come from env (CI secrets): E2E_USER + E2E_PASSWORD. This replaces
// the old WorkOS-era captured-session mechanism — with a self-hosted IdP the
// suite performs an actual login, which is itself a critical user journey.

export function hasAuth(): boolean {
  return Boolean(process.env.E2E_USER?.trim() && process.env.E2E_PASSWORD?.trim());
}

const KC_FORM = "#kc-form-login, form#kc-form-login, input#username";

/**
 * Sign in to one app. Handles both the first login (Keycloak form) and
 * subsequent apps (silent SSO redirect straight back to the app).
 */
export async function kcLogin(page: Page, appUrl: string): Promise<void> {
  const user = process.env.E2E_USER!;
  const pass = process.env.E2E_PASSWORD!;
  const appOrigin = new URL(appUrl).origin;

  await page.goto(`${appUrl.replace(/\/$/, "")}/auth/sign-in`, { waitUntil: "domcontentloaded" });

  // Either we bounce through Keycloak silently (SSO cookie already set) and land
  // back on the app, or the Keycloak login form renders and we submit it.
  const backOnApp = () => page.url().startsWith(appOrigin) && !page.url().includes("/auth/sign-in");
  for (let i = 0; i < 40; i++) {
    if (backOnApp()) return;
    const form = page.locator(KC_FORM).first();
    if (await form.isVisible().catch(() => false)) break;
    await page.waitForTimeout(250);
  }
  if (!backOnApp()) {
    await page.locator("#username").fill(user);
    await page.locator("#password").fill(pass);
    await page.locator("#kc-login").click();
    await page.waitForURL((u) => u.origin === appOrigin, { timeout: 20_000 });
  }
}

/** Sign in to every authed app in one context so the saved storageState carries
 *  each app's session cookie (sessions are per-app iron-session cookies; the
 *  Keycloak SSO cookie makes app 2..n silent). */
export async function loginAllApps(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  for (const app of [targets.forge, targets.market, targets.auto, targets.profile]) {
    await kcLogin(page, app);
  }
  await page.close();
}
