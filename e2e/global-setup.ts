import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "@playwright/test";
import { hasAuth, loginAllApps } from "./lib/auth";

export const STORAGE_STATE_PATH = "auth/state.json";
const EMPTY_STATE = JSON.stringify({ cookies: [], origins: [] });

// Sign the dedicated E2E user in via REAL Keycloak form login (E2E_USER +
// E2E_PASSWORD env / CI secrets) and persist the storageState all authed
// projects reuse. One login per run; app 2..n are silent SSO.
//
// When no credentials are supplied, write an EMPTY state so the storageState
// path always resolves (Playwright errors on a missing file) and authed specs
// self-skip via `hasRealSession()`.
export default async function globalSetup(): Promise<void> {
  mkdirSync(dirname(STORAGE_STATE_PATH), { recursive: true });
  if (!hasAuth()) {
    writeFileSync(STORAGE_STATE_PATH, EMPTY_STATE, { encoding: "utf8" });
    return;
  }
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await loginAllApps(context);
    await context.storageState({ path: STORAGE_STATE_PATH });
    await context.close();
  } finally {
    await browser.close();
  }
}

/** True when the run has an authenticated session (creds were supplied). */
export function hasRealSession(): boolean {
  return hasAuth();
}
