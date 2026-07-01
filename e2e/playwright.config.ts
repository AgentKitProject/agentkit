import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE_PATH } from "./global-setup";

// Standalone E2E config. Runs against DEPLOYED apps (hosted prod by default).
// Two projects:
//   - smoke:  unauthenticated critical-path checks (no secrets needed).
//   - authed: reuses a dedicated test user's storageState if provided; the
//             authed specs self-skip when no session is available.
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  // Prod is a shared resource — never hammer it. Small, serial-ish, retried.
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: 2,
  timeout: 30_000,
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
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "authed",
      testMatch: /authed\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE_PATH },
    },
  ],
});
