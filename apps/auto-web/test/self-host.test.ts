// Self-host vs hosted config resolution (lib/self-host.ts). These pin the rule
// that HOSTED defaults (no flags) are unchanged, and that self-host never falls
// back to the hosted Market. Adapted from agentkitforge-web/test/self-host.test.ts.
import { describe, expect, it } from "vitest";
import {
  isSelfHost,
  getMarketBaseUrl,
  isMarketEnabled,
  isManagedInferenceEnabled,
  isSelfHostManagedBilling,
  usesPlatformCreditLedger,
  creditLedgerBackend,
  getEcosystemLinks,
  getPublicConfig
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

describe("managed inference + billing gating", () => {
  it("HOSTED (Dynamo, default) keeps managed inference on the platform ledger", () => {
    expect(isManagedInferenceEnabled({})).toBe(true);
    expect(usesPlatformCreditLedger({})).toBe(true);
    // Default backend (aws/local) + managed → the Dynamo ledger.
    expect(creditLedgerBackend({})).toBe("dynamo");
    expect(creditLedgerBackend({ KITSTORE_BACKEND: "aws" })).toBe("dynamo");
  });

  it("SELF-HOST (free, default) disables managed inference + platform ledger", () => {
    expect(isManagedInferenceEnabled({ SELF_HOST: "true" })).toBe(false);
    expect(isSelfHostManagedBilling({ SELF_HOST: "true" })).toBe(false);
    expect(usesPlatformCreditLedger({ SELF_HOST: "true" })).toBe(false);
    // Free billing → the inert free ledger (even on the Postgres backend).
    expect(creditLedgerBackend({ SELF_HOST: "true" })).toBe("free");
    expect(
      creditLedgerBackend({ SELF_HOST: "true", KITSTORE_BACKEND: "selfhost" })
    ).toBe("free");
  });

  it("SELF-HOST managed billing uses the Postgres ledger (never the Dynamo platform ledger)", () => {
    const env = {
      SELF_HOST: "true",
      KITSTORE_BACKEND: "selfhost",
      AUTO_SELFHOST_BILLING: "managed"
    };
    expect(isSelfHostManagedBilling(env)).toBe(true);
    expect(isManagedInferenceEnabled(env)).toBe(true);
    // Postgres ledger — NOT the hosted DynamoDB platform ledger.
    expect(usesPlatformCreditLedger(env)).toBe(false);
    expect(creditLedgerBackend(env)).toBe("postgres");
  });

  it("HOSTED on Postgres + managed billing selects the Postgres ledger (decoupled from SELF_HOST)", () => {
    // The NEW capability: hosted Auto (SELF_HOST=false, AUTH_PROVIDER=workos)
    // running on the Postgres/DOKS backend with managed billing bills via the
    // Postgres credit ledger — NOT the Dynamo platform ledger, and NOT free.
    const env = {
      AUTH_PROVIDER: "workos",
      SELF_HOST: "false",
      KITSTORE_BACKEND: "selfhost",
      AUTO_SELFHOST_BILLING: "managed"
    };
    expect(isSelfHost(env)).toBe(false);
    expect(isManagedInferenceEnabled(env)).toBe(true);
    expect(creditLedgerBackend(env)).toBe("postgres");
    // Decoupled: it is NOT the Dynamo platform ledger despite being hosted.
    expect(usesPlatformCreditLedger(env)).toBe(false);
    // The self-host-scoped opt-in helper stays false on a hosted instance.
    expect(isSelfHostManagedBilling(env)).toBe(false);
  });

  it("HOSTED ignores AUTO_SELFHOST_BILLING for managed-inference gating + the self-host opt-in flag", () => {
    // On hosted (no self-host signal), managed inference is always on and the
    // self-host opt-in helper is always false — regardless of AUTO_SELFHOST_BILLING.
    expect(isSelfHostManagedBilling({ AUTO_SELFHOST_BILLING: "managed" })).toBe(false);
    expect(isManagedInferenceEnabled({ AUTO_SELFHOST_BILLING: "free" })).toBe(true);
    // Hosted on the default Dynamo backend stays on the Dynamo ledger even if
    // someone sets AUTO_SELFHOST_BILLING=free (that knob is self-host-only).
    expect(creditLedgerBackend({ AUTO_SELFHOST_BILLING: "free" })).toBe("dynamo");
  });
});

describe("ecosystem links", () => {
  it("HOSTED returns the public *.agentkitproject.com links by default", () => {
    const links = getEcosystemLinks({});
    expect(links.projectUrl).toBe("https://agentkitproject.com");
    expect(links.marketUrl).toBe(HOSTED_MARKET);
    expect(links.forgeUrl).toBe("https://forge.agentkitproject.com");
    expect(links.profileUrl).toBe("https://profile.agentkitproject.com");
  });

  it("SELF-HOST omits unconfigured links (no link back into our ecosystem)", () => {
    const links = getEcosystemLinks({ SELF_HOST: "true" });
    expect(links.projectUrl).toBeUndefined();
    expect(links.marketUrl).toBeUndefined();
    expect(links.forgeUrl).toBeUndefined();
    expect(links.profileUrl).toBeUndefined();
  });

  it("SELF-HOST surfaces operator-configured links", () => {
    const env = {
      SELF_HOST: "true",
      // marketUrl is the BROWSER url (NEXT_PUBLIC_MARKET_URL), not the in-cluster
      // server-side AGENTKITMARKET_BASE_URL — the app-switcher links must be
      // browser-reachable.
      NEXT_PUBLIC_MARKET_URL: "https://market.acme.internal",
      NEXT_PUBLIC_PROFILE_URL: "https://id.acme.internal"
    };
    const links = getEcosystemLinks(env);
    expect(links.marketUrl).toBe("https://market.acme.internal");
    expect(links.profileUrl).toBe("https://id.acme.internal");
    expect(links.projectUrl).toBeUndefined();
    // Docs always defaults (the single allowed external link even on self-host).
    expect(links.docsUrl).toBe("https://docs.agentkitproject.com");
  });
});

describe("getPublicConfig snapshot", () => {
  it("HOSTED default snapshot is unchanged behavior", () => {
    expect(getPublicConfig({})).toEqual({
      selfHost: false,
      marketEnabled: true,
      managedBilling: true,
      // Provider-lock: unrestricted by default (no ALLOWED_PROVIDERS set).
      allowedProviders: null,
      links: {
        projectUrl: "https://agentkitproject.com",
        marketUrl: HOSTED_MARKET,
        forgeUrl: "https://forge.agentkitproject.com",
        profileUrl: "https://profile.agentkitproject.com",
        docsUrl: "https://docs.agentkitproject.com"
      }
    });
  });

  it("SELF-HOST snapshot disables Market + managed billing and drops links", () => {
    const cfg = getPublicConfig({ SELF_HOST: "true" });
    expect(cfg.selfHost).toBe(true);
    expect(cfg.marketEnabled).toBe(false);
    expect(cfg.managedBilling).toBe(false);
    // Only Docs remains (always-defaulted external link); all other cross-app
    // links are dropped on self-host unless the operator configures them.
    expect(cfg.links).toEqual({ docsUrl: "https://docs.agentkitproject.com" });
  });
});
