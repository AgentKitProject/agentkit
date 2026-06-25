import type { CSSProperties } from "react";

/**
 * Canonical per-app brand accents for the AgentKitProject ecosystem.
 *
 * Single source of truth so the apps stop hardcoding hex (they drift otherwise).
 * Each entry has the base `accent` (→ `--ak-brand`) and a darker `strong`
 * (→ `--ak-brand-strong`, used for hover/pressed). `soft` (→ `--ak-brand-soft`)
 * is left to the framework's `color-mix` derivation unless an app needs a
 * specific tint. Mirrors the table in UI_FRAMEWORK_ROLLOUT.md §4.
 *
 * Apps wire these via the shell's `brandAccent`/`brandAccentStrong` props or
 * `brandVars()`, e.g.
 *   `<SiteShell brandAccent={BRAND_ACCENTS.market.accent}
 *               brandAccentStrong={BRAND_ACCENTS.market.strong} />`.
 *
 * Note: `site` (purple) is the Astro marketing site's accent and is included
 * for completeness; the React shells aren't used there.
 */
export const BRAND_ACCENTS = {
  forge: { accent: "#4f46e5", strong: "#4338ca" }, // indigo
  market: { accent: "#0fb3d1", strong: "#0b8ba6" }, // cyan
  auto: { accent: "#16a34a", strong: "#15803d" }, // green
  profile: { accent: "#2f8f89", strong: "#24736e" }, // teal
  site: { accent: "#6d46e9", strong: "#5a36c9" }, // purple (Astro site only)
} as const;

/** A known brand-accent key. */
export type BrandKey = keyof typeof BRAND_ACCENTS;

/** A single brand-accent entry: base `accent` + darker `strong`. */
export type BrandAccent = (typeof BRAND_ACCENTS)[BrandKey];

/**
 * Build an inline style object that overrides the brand-accent CSS variables.
 * Apps rebrand with one call: `style={brandVars("#0fb3d1")}`.
 *
 * If `strong`/`soft` are omitted, sensible derivations are used:
 *  - strong: the accent itself (apps should pass a darker shade for best hover)
 *  - soft: a translucent tint of the accent via color-mix
 */
export function brandVars(
  accent: string,
  strong?: string,
  soft?: string,
): CSSProperties {
  const vars: Record<string, string> = {
    "--ak-brand": accent,
    "--ak-brand-strong": strong ?? accent,
    "--ak-brand-soft":
      soft ?? `color-mix(in srgb, ${accent} 14%, transparent)`,
  };
  return vars as CSSProperties;
}
