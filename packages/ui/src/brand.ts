import type { CSSProperties } from "react";

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
