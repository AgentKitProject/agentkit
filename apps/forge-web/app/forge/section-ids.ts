/**
 * Canonical SectionId type and validation helper for the web Forge deep-link
 * mechanism. Kept in a separate module so tests can import it without pulling
 * in the React component tree.
 */

export type SectionId =
  | "my-kits"
  | "build"
  | "use"
  | "run"
  | "import"
  | "package-export"
  | "install-targets"
  | "market-submit"
  | "settings"
  | "account"
  | "about";

/** All IDs reachable via the ?section= deep-link query param. */
export const SECTION_IDS: ReadonlySet<string> = new Set<SectionId>([
  "my-kits",
  "build",
  "use",
  "run",
  "import",
  "package-export",
  "install-targets",
  "market-submit",
  "settings",
  "account",
  "about",
]);

/**
 * AgentKitAuto is now a standalone app (auto.agentkitproject.com); it is no
 * longer an embedded Forge section. Web Forge links out to it instead of
 * rendering it. The legacy `?section=auto` deep link redirects here.
 */
export const AUTO_APP_URL = "https://auto.agentkitproject.com";

/** Returns true if `s` is a known SectionId that can be jumped to via ?section=. */
export function isValidSectionId(s: string): s is SectionId {
  return SECTION_IDS.has(s);
}
