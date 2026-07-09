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
  getPublicConfig,
  getAllowedProviders,
  isProviderAllowed
} from "@/lib/self-host";

const HOSTED_MARKET = "https://market.agentkitproject.com";

describe("self-host signal", () => {
  it("hosted by default (no flags)", () => {
    expect(isSelfHost({})).toBe(false);
    expect(isSelfHost({ AUTH_PROVIDER: "workos" })).toBe(false);
  });

  it("self-host via explicit SELF_HOST=true", () => {
    expect(isSelfHost({ SELF_HOST: "true" })).toBe(true);
    expect(isSelfHost({ SELF_HOST: "1" })).toBe(true);
    expect(isSelfHost({ SELF_HOST: "false" })).toBe(false);
  });

  it("AUTH_PROVIDER=oidc alone does NOT imply self-host (OIDC is usable by hosted too)", () => {
    expect(isSelfHost({ AUTH_PROVIDER: "oidc" })).toBe(false);
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
    expect(getMarketBaseUrl({ SELF_HOST: "true" })).toBeUndefined();
    expect(isMarketEnabled({ SELF_HOST: "true" })).toBe(false);
  });

  it("SELF-HOST can point at its OWN Market", () => {
    const env = { SELF_HOST: "true", AGENTKITMARKET_BASE_URL: "https://market.acme.internal" };
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
    expect(isManagedInferenceEnabled({ SELF_HOST: "true" })).toBe(false);
  });

  it("credits UI requires managed inference AND a Stripe key", () => {
    expect(isCreditsUiEnabled({})).toBe(false); // no Stripe key
    expect(isCreditsUiEnabled({ STRIPE_SECRET_KEY: "sk_test_x" })).toBe(true);
    // Self-host never shows credits even with a Stripe key.
    expect(isCreditsUiEnabled({ SELF_HOST: "true", STRIPE_SECRET_KEY: "sk_test_x" })).toBe(false);
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

  it("HOSTED marketUrl is the PUBLIC Market, never the in-cluster API base", () => {
    // On hosted prod AGENTKITMARKET_BASE_URL is the in-cluster Service URL
    // (browser-unreachable). The browser-facing marketUrl must NOT fall back to
    // it — it stays the public Market — while the server-side API base is still
    // that in-cluster URL. (Regression: forge nav "Market" link 404'd on prod.)
    const env = { AGENTKITMARKET_BASE_URL: "http://agentkitmarket-web" };
    expect(getEcosystemLinks(env).marketUrl).toBe(HOSTED_MARKET);
    expect(getMarketBaseUrl(env)).toBe("http://agentkitmarket-web");
  });

  it("SELF-HOST omits unconfigured links (no link back into our ecosystem)", () => {
    const links = getEcosystemLinks({ SELF_HOST: "true" });
    expect(links.projectUrl).toBeUndefined();
    expect(links.marketUrl).toBeUndefined();
    expect(links.forgeUrl).toBeUndefined();
    expect(links.profileUrl).toBeUndefined();
    expect(links.autoUrl).toBeUndefined();
  });

  it("SELF-HOST surfaces operator-configured links", () => {
    const env = {
      SELF_HOST: "true",
      // The Market browser link comes from NEXT_PUBLIC_MARKET_URL only (never the
      // in-cluster AGENTKITMARKET_BASE_URL, which isn't browser-reachable).
      NEXT_PUBLIC_MARKET_URL: "https://market.acme.internal",
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
        autoUrl: "https://auto.agentkitproject.com",
        docsUrl: "https://docs.agentkitproject.com"
      },
      allowedProviders: null
    });
  });

  it("SELF-HOST snapshot disables Market + credits and drops links", () => {
    const cfg = getPublicConfig({ SELF_HOST: "true" });
    expect(cfg.selfHost).toBe(true);
    expect(cfg.marketEnabled).toBe(false);
    expect(cfg.creditsEnabled).toBe(false);
    // Only Docs remains (always-defaulted external link); all other cross-app
    // links are dropped on self-host unless the operator configures them.
    expect(cfg.links).toEqual({ docsUrl: "https://docs.agentkitproject.com" });
    expect(cfg.allowedProviders).toBeNull();
  });

  it("snapshot carries the provider-lock subset when ALLOWED_PROVIDERS is set", () => {
    const cfg = getPublicConfig({ ALLOWED_PROVIDERS: "anthropic, openai" });
    expect(cfg.allowedProviders).toEqual(["anthropic", "openai"]);
  });
});

describe("provider-lock (ALLOWED_PROVIDERS)", () => {
  it("unset or empty ⇒ null (unrestricted)", () => {
    expect(getAllowedProviders({})).toBeNull();
    expect(getAllowedProviders({ ALLOWED_PROVIDERS: "" })).toBeNull();
    expect(getAllowedProviders({ ALLOWED_PROVIDERS: "   " })).toBeNull();
  });

  it("parses + validates the subset of the 5 provider types", () => {
    expect(getAllowedProviders({ ALLOWED_PROVIDERS: "anthropic,openai" })).toEqual([
      "anthropic",
      "openai"
    ]);
    // case-insensitive, trims whitespace, drops unknowns, de-duplicates
    expect(
      getAllowedProviders({ ALLOWED_PROVIDERS: " Anthropic , bogus, OPENAI , anthropic " })
    ).toEqual(["anthropic", "openai"]);
  });

  it("all-unknown tokens ⇒ null (treated as unrestricted, not all-blocked)", () => {
    expect(getAllowedProviders({ ALLOWED_PROVIDERS: "bogus,nope" })).toBeNull();
  });

  it("isProviderAllowed honors the policy", () => {
    expect(isProviderAllowed("gemini", {})).toBe(true); // unrestricted
    expect(isProviderAllowed("anthropic", { ALLOWED_PROVIDERS: "anthropic" })).toBe(true);
    expect(isProviderAllowed("openai", { ALLOWED_PROVIDERS: "anthropic" })).toBe(false);
  });
});
