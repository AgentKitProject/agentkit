// Self-host vs hosted-SaaS configuration for the Profile web app — the single
// source of truth for whether this instance is self-hosted and which cross-
// ecosystem links the top nav should surface.
//
// SELF-HOST SIGNAL:
//   - SELF_HOST=true     — the explicit, sole signal that this instance is
//                          self-hosted. OIDC is just an auth mechanism usable by
//                          BOTH hosted and self-host, so AUTH_PROVIDER=oidc alone
//                          does NOT imply self-host (the hosted SaaS may run OIDC).
//
// HOSTED (the default) behaves exactly as before: the top nav shows the canonical
// *.agentkitproject.com ecosystem tabs. On SELF-HOST we NEVER point users back
// into our hosted ecosystem — the ecosystem tabs are dropped and only links the
// operator explicitly configures (NEXT_PUBLIC_*_URL) are surfaced.
//
// Mirrors apps/market-web/lib/self-host.ts (same signal + link semantics) so every
// self-hostable app resolves "am I self-hosted, and where do I link" identically.
// Everything reads process.env at call time (never baked at build) and is pure.

type Env = Record<string, string | undefined>;

function trimmed(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && v.length > 0 ? v : undefined;
}

function truthy(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/** True when this Profile instance is self-hosted (explicit SELF_HOST only). */
export function isSelfHost(env: Env = process.env): boolean {
  return truthy(env.SELF_HOST);
}

/**
 * Cross-ecosystem link bases for the top nav. On hosted these are the public
 * *.agentkitproject.com properties. On self-host they are OMITTED (undefined)
 * unless the operator configures the matching NEXT_PUBLIC_*_URL, so the nav hides
 * the tab rather than pointing a self-host user back into our hosted ecosystem.
 */
export interface EcosystemLinks {
  /** Marketing/project site (Home). */
  projectUrl?: string;
  /** Public Market web app. */
  marketUrl?: string;
  /** Hosted Forge marketing/download page. */
  forgeUrl?: string;
  /** Standalone AgentKitAuto app. */
  autoUrl?: string;
  /** Identity / profile management (account dropdown). */
  profileUrl?: string;
  /** Docs site. */
  docsUrl?: string;
}

export function getEcosystemLinks(env: Env = process.env): EcosystemLinks {
  if (!isSelfHost(env)) {
    return {
      projectUrl: trimmed(env.NEXT_PUBLIC_PROJECT_URL) ?? "https://agentkitproject.com",
      marketUrl: trimmed(env.NEXT_PUBLIC_MARKET_URL) ?? "https://market.agentkitproject.com",
      forgeUrl: trimmed(env.NEXT_PUBLIC_FORGE_URL) ?? "https://forge.agentkitproject.com",
      autoUrl: trimmed(env.NEXT_PUBLIC_AUTO_URL) ?? "https://auto.agentkitproject.com",
      profileUrl: trimmed(env.NEXT_PUBLIC_PROFILE_URL) ?? "https://profile.agentkitproject.com",
      docsUrl: trimmed(env.NEXT_PUBLIC_DOCS_URL) ?? "https://docs.agentkitproject.com",
    };
  }
  // Self-host: only surface links the operator explicitly configures —
  // EXCEPT Docs, which is the single allowed external link in the sidebar even
  // on self-host (defaults to the public docs site). Forge/Auto/Market are never
  // surfaced in nav on self-host unless configured.
  return {
    projectUrl: trimmed(env.NEXT_PUBLIC_PROJECT_URL),
    marketUrl: trimmed(env.NEXT_PUBLIC_MARKET_URL),
    forgeUrl: trimmed(env.NEXT_PUBLIC_FORGE_URL),
    autoUrl: trimmed(env.NEXT_PUBLIC_AUTO_URL),
    profileUrl: trimmed(env.NEXT_PUBLIC_PROFILE_URL),
    docsUrl: trimmed(env.NEXT_PUBLIC_DOCS_URL) ?? "https://docs.agentkitproject.com",
  };
}
