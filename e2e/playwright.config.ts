import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE_PATH } from "./global-setup";

// Standalone E2E config. Runs against DEPLOYED apps (hosted prod by default;
// the gamma pipeline overrides URLs + E2E_ENV=gamma).
//
// Projects (pick with --project=…):
//   - smoke:    unauthenticated critical-path checks (no secrets needed).
//   - authed:   read-only authed checks (real Keycloak login via global-setup).
//   - cuj:      the FULL critical-user-journey suite incl. writes — gamma's
//               promotion gate. Serial to avoid cross-journey interference;
//               every artifact is RUN_ID-prefixed and cleaned up.
//   - prod-cuj: the REVERSIBLE subset (tests tagged @reversible) — prod's
//               promotion gate. No purchases, no irreversible writes.
//   - canary:   the light health subset (tests tagged @canary) — the cron.
const chrome = { ...devices["Desktop Chrome"] };

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  // Prod is a shared resource — never hammer it. Small, serial-ish, retried.
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: 2,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: "smoke",
      testMatch: /smoke\.spec\.ts/,
      use: chrome,
    },
    {
      name: "authed",
      testMatch: /authed\.spec\.ts/,
      use: { ...chrome, storageState: STORAGE_STATE_PATH },
    },
    {
      // Full CUJ suite (gamma gate). Write journeys interleave badly, so run
      // the CUJ files serially regardless of the global worker count.
      name: "cuj",
      testMatch: /cuj\/.*\.spec\.ts/,
      grepInvert: /@wip/, // newly-authored CUJs stay dormant until verified
      fullyParallel: false,
      workers: 1,
      timeout: 90_000,
      use: { ...chrome, storageState: STORAGE_STATE_PATH },
    },
    {
      // Reversible subset only (prod gate).
      name: "prod-cuj",
      testMatch: /cuj\/.*\.spec\.ts/,
      grep: /@reversible/,
      grepInvert: /@wip/, // exclude unverified WIP tests from the prod gate
      fullyParallel: false,
      workers: 1,
      timeout: 90_000,
      use: { ...chrome, storageState: STORAGE_STATE_PATH },
    },
    {
      // Continuous health cron: light, read-mostly, fast. Runs ANONYMOUS by
      // default so @canary tests that assert anonymous behavior (sign-in
      // redirects) hold; authed.spec.ts opts into the storageState itself
      // via test.use, so its @canary tests still run authenticated.
      name: "canary",
      grep: /@canary/,
      grepInvert: /@wip/,
      use: chrome,
    },
    {
      // WIP staging lane: newly-authored CUJs are tagged @wip so they do NOT
      // gate deploys (cuj/prod-cuj/canary all exclude @wip) until shaken out.
      // Run explicitly with `--project=wip` against a deployed env; drop the
      // @wip tag from a test once it's green to promote it into cuj / prod-cuj.
      name: "wip",
      testMatch: /cuj\/.*\.spec\.ts/,
      grep: /@wip/,
      fullyParallel: false,
      workers: 1,
      timeout: 90_000,
      use: { ...chrome, storageState: STORAGE_STATE_PATH },
    },
  ],
});
