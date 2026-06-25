// Self-host vs hosted config resolution (lib/self-host.ts). These pin the rule
// that HOSTED defaults (no flags) are unchanged, and that self-host never falls
// back to the hosted Market.
import { describe, expect, it } from "vitest";
import {
  isSelfHost,
  getMarketBaseUrl,
  isMarketEnabled,
  isManagedInferenceEnabled,
  isCreditsUiEnabled,
  getEcosystemLinks,
  getPublicConfig
} from "@/lib/self-host";

const HOSTED_MARKET = "https://market.agentkitproject.com";

describe("self-host signal", () => {
  it("hosted by default (no flags)", () => {
    expect(isSelfHost({})).toBe(false);
    expect(isSelfHost({ AUTH_PROVIDER: "workos" })).toBe(false);
  });

  it("self-host via AUTH_PROVIDER=oidc", () => {
    expect(isSelfHost({ AUTH_PROVIDER: "oidc" })).toBe(true);
  });

  it("self-host via explicit SELF_HOST=true", () => {
    expect(isSelfHost({ SELF_HOST: "true" })).toBe(true);
    expect(isSelfHost({ SELF_HOST: "1" })).toBe(true);
    expect(isSelfHost({ SELF_HOST: "false" })).toBe(false);
  });
});

describe("Market base URL resolution", () => {
  it("HOSTED falls back to the public Market when env unset", () => {
    expect(getMarketBaseUrl({})).toBe(HOSTED_MARKET);
    expect(isMarketEnabled({})).toBe(true);
  });

  it("HOSTED honors a configured Market URL", () => {
    expect(getMarketBaseUrl({ AGENTKITMARKET_BASE_URL: "https://m.example.com" })).toBe(
      "https://m.example.com"
    );
  });

  it("SELF-HOST never falls back to the hosted Market (disabled when unset)", () => {
    expect(getMarketBaseUrl({ AUTH_PROVIDER: "oidc" })).toBeUndefined();
    expect(isMarketEnabled({ AUTH_PROVIDER: "oidc" })).toBe(false);
    expect(getMarketBaseUrl({ SELF_HOST: "true" })).toBeUndefined();
  });

  it("SELF-HOST can point at its OWN Market", () => {
    const env = { AUTH_PROVIDER: "oidc", AGENTKITMARKET_BASE_URL: "https://market.acme.internal" };
    expect(getMarketBaseUrl(env)).toBe("https://market.acme.internal");
    expect(isMarketEnabled(env)).toBe(true);
  });

  it("DISABLE_MARKET forces Market off even on hosted", () => {
    expect(getMarketBaseUrl({ DISABLE_MARKET: "true" })).toBeUndefined();
    expect(isMarketEnabled({ DISABLE_MARKET: "true", AGENTKITMARKET_BASE_URL: HOSTED_MARKET })).toBe(false);
  });
});

describe("managed inference + credits gating", () => {
  it("HOSTED keeps managed inference on", () => {
    expect(isManagedInferenceEnabled({})).toBe(true);
  });

  it("SELF-HOST disables managed inference (BYO-key only)", () => {
    expect(isManagedInferenceEnabled({ AUTH_PROVIDER: "oidc" })).toBe(false);
    expect(isManagedInferenceEnabled({ SELF_HOST: "true" })).toBe(false);
  });

  it("credits UI requires managed inference AND a Stripe key", () => {
    expect(isCreditsUiEnabled({})).toBe(false); // no Stripe key
    expect(isCreditsUiEnabled({ STRIPE_SECRET_KEY: "sk_test_x" })).toBe(true);
    // Self-host never shows credits even with a Stripe key.
    expect(isCreditsUiEnabled({ AUTH_PROVIDER: "oidc", STRIPE_SECRET_KEY: "sk_test_x" })).toBe(false);
  });
});

describe("ecosystem links", () => {
  it("HOSTED returns the public *.agentkitproject.com links by default", () => {
    const links = getEcosystemLinks({});
    expect(links.projectUrl).toBe("https://agentkitproject.com");
    expect(links.marketUrl).toBe(HOSTED_MARKET);
    expect(links.forgeUrl).toBe("https://forge.agentkitproject.com");
    expect(links.profileUrl).toBe("https://profile.agentkitproject.com");
    expect(links.autoUrl).toBe("https://auto.agentkitproject.com");
  });

  it("SELF-HOST omits unconfigured links (no link back into our ecosystem)", () => {
    const links = getEcosystemLinks({ AUTH_PROVIDER: "oidc" });
    expect(links.projectUrl).toBeUndefined();
    expect(links.marketUrl).toBeUndefined();
    expect(links.forgeUrl).toBeUndefined();
    expect(links.profileUrl).toBeUndefined();
    expect(links.autoUrl).toBeUndefined();
  });

  it("SELF-HOST surfaces operator-configured links", () => {
    const env = {
      AUTH_PROVIDER: "oidc",
      AGENTKITMARKET_BASE_URL: "https://market.acme.internal",
      NEXT_PUBLIC_PROFILE_URL: "https://id.acme.internal",
      NEXT_PUBLIC_AUTO_URL: "https://auto.acme.internal"
    };
    const links = getEcosystemLinks(env);
    expect(links.marketUrl).toBe("https://market.acme.internal");
    expect(links.profileUrl).toBe("https://id.acme.internal");
    expect(links.autoUrl).toBe("https://auto.acme.internal");
    expect(links.projectUrl).toBeUndefined();
  });
});

describe("getPublicConfig snapshot", () => {
  it("HOSTED default snapshot is unchanged behavior", () => {
    expect(getPublicConfig({})).toEqual({
      selfHost: false,
      marketEnabled: true,
      creditsEnabled: false,
      links: {
        projectUrl: "https://agentkitproject.com",
        marketUrl: HOSTED_MARKET,
        forgeUrl: "https://forge.agentkitproject.com",
        profileUrl: "https://profile.agentkitproject.com",
        autoUrl: "https://auto.agentkitproject.com"
      }
    });
  });

  it("SELF-HOST snapshot disables Market + credits and drops links", () => {
    const cfg = getPublicConfig({ AUTH_PROVIDER: "oidc" });
    expect(cfg.selfHost).toBe(true);
    expect(cfg.marketEnabled).toBe(false);
    expect(cfg.creditsEnabled).toBe(false);
    expect(cfg.links).toEqual({});
  });
});
