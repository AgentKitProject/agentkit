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
      fullyParallel: false,
      workers: 1,
      timeout: 90_000,
      use: { ...chrome, storageState: STORAGE_STATE_PATH },
    },
    {
      // Continuous health cron: light, read-mostly, fast.
      name: "canary",
      grep: /@canary/,
      use: { ...chrome, storageState: STORAGE_STATE_PATH },
    },
  ],
});
