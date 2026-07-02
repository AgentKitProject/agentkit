// Deployed app URLs under test. Defaults are hosted prod; the gamma (self-host
// staging) pipeline overrides everything via env. `envName` drives env-specific
// expectations (gamma runs a private catalog; prod is public).
export const envName = (process.env.E2E_ENV ?? "prod") as "prod" | "gamma";

export const targets = {
  profile: process.env.E2E_PROFILE_URL ?? "https://profile.agentkitproject.com",
  market: process.env.E2E_MARKET_URL ?? "https://market.agentkitproject.com",
  forge: process.env.E2E_FORGE_URL ?? "https://forge.agentkitproject.com",
  /** @deprecated alias for `forge` (the desktop app is retired; one Forge now). */
  webForge: process.env.E2E_WEBFORGE_URL ?? process.env.E2E_FORGE_URL ?? "https://forge.agentkitproject.com",
  auto: process.env.E2E_AUTO_URL ?? "https://auto.agentkitproject.com",
  site: process.env.E2E_SITE_URL ?? "https://agentkitproject.com",
  auth: process.env.E2E_AUTH_URL ?? "https://auth.agentkitproject.com",
} as const;

export type AppKey = keyof typeof targets;

/** Gamma's self-host Market defaults to REQUIRE_LOGIN=true (private catalog). */
export const catalogIsPublic = envName === "prod";

/** Unique per-run prefix for every artifact the suite creates (kits, orgs, …).
 *  Everything E2E-created is identifiable as `e2e-*` for cleanup/sweeps. */
export const RUN_ID = `e2e-${(process.env.GITHUB_RUN_ID ?? Date.now().toString(36)).slice(-10)}`;
