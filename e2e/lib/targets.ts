// Deployed app URLs under test. Default to hosted prod; override any via env so
// the same suite can point at a staging/canary or self-host tailnet later.
export const targets = {
  profile: process.env.E2E_PROFILE_URL ?? "https://profile.agentkitproject.com",
  market: process.env.E2E_MARKET_URL ?? "https://market.agentkitproject.com",
  forge: process.env.E2E_FORGE_URL ?? "https://forge.agentkitproject.com",
  webForge: process.env.E2E_WEBFORGE_URL ?? "https://webapp.forge.agentkitproject.com",
  auto: process.env.E2E_AUTO_URL ?? "https://auto.agentkitproject.com",
} as const;

export type AppKey = keyof typeof targets;
