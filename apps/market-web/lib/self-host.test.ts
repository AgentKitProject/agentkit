// Self-host signal + ecosystem-link resolution (lib/self-host.ts). Pins the rule
// that HOSTED defaults (no flags) surface the canonical *.agentkitproject.com
// links, and that a self-host instance surfaces ONLY operator-configured links.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSelfHost, getEcosystemLinks } from "./self-host.ts";

describe("isSelfHost", () => {
  it("hosted by default (no flags)", () => {
    assert.equal(isSelfHost({}), false);
  });
  it("true when AUTH_PROVIDER=oidc", () => {
    assert.equal(isSelfHost({ AUTH_PROVIDER: "oidc" }), true);
  });
  it("true when SELF_HOST is truthy", () => {
    assert.equal(isSelfHost({ SELF_HOST: "true" }), true);
    assert.equal(isSelfHost({ SELF_HOST: "1" }), true);
    assert.equal(isSelfHost({ SELF_HOST: "yes" }), true);
  });
  it("false for an unrelated AUTH_PROVIDER", () => {
    assert.equal(isSelfHost({ AUTH_PROVIDER: "workos" }), false);
  });
});

describe("getEcosystemLinks", () => {
  it("hosted returns the public *.agentkitproject.com links", () => {
    const links = getEcosystemLinks({});
    assert.equal(links.projectUrl, "https://agentkitproject.com");
    assert.equal(links.forgeUrl, "https://forge.agentkitproject.com");
    assert.equal(links.autoUrl, "https://auto.agentkitproject.com");
    assert.equal(links.profileUrl, "https://profile.agentkitproject.com");
    assert.equal(links.docsUrl, "https://docs.agentkitproject.com");
  });

  it("self-host with no overrides surfaces NO ecosystem links (except Docs, which always defaults)", () => {
    const links = getEcosystemLinks({ AUTH_PROVIDER: "oidc" });
    assert.equal(links.projectUrl, undefined);
    assert.equal(links.forgeUrl, undefined);
    assert.equal(links.autoUrl, undefined);
    assert.equal(links.profileUrl, undefined);
    // Docs is the single allowed external link in the sidebar even on self-host.
    assert.equal(links.docsUrl, "https://docs.agentkitproject.com");
  });

  it("self-host surfaces ONLY operator-configured links", () => {
    const links = getEcosystemLinks({
      SELF_HOST: "true",
      NEXT_PUBLIC_FORGE_URL: "https://forge.internal.example.com",
      NEXT_PUBLIC_AUTO_URL: "https://auto.internal.example.com",
    });
    assert.equal(links.forgeUrl, "https://forge.internal.example.com");
    assert.equal(links.autoUrl, "https://auto.internal.example.com");
    assert.equal(links.projectUrl, undefined);
    assert.equal(links.profileUrl, undefined);
    // Docs still defaults even when other ecosystem links are operator-only.
    assert.equal(links.docsUrl, "https://docs.agentkitproject.com");
  });
});
