// NOTE: deliberately NOT a "use client" module. `themeInitScript` and
// `THEME_STORAGE_KEY` are pure (no React, no browser globals) and are called
// from server components (Next root layouts) to emit a pre-paint <head>
// script. The React hook `useTheme` lives in ./use-theme.ts (client-tagged).

/**
 * localStorage key the whole ecosystem persists the chosen theme under. The
 * pre-paint inline script (`themeInitScript`) and the `ThemeToggle` read/write
 * this same key, so all surfaces stay in sync. Don't change without migrating
 * existing users' stored preference.
 */
export const THEME_STORAGE_KEY = "akf-theme";

export type Theme = "light" | "dark";

/**
 * A self-contained, FOUC-free inline `<head>` script (as a string) that sets
 * `data-theme` on <html> BEFORE React hydrates, from the same source the
 * `ThemeToggle` reads: `localStorage("akf-theme")`, falling back to the OS
 * `prefers-color-scheme`. Apps drop this into a `<script
 * dangerouslySetInnerHTML={{ __html: themeInitScript() }} />` and set
 * `suppressHydrationWarning` on <html>.
 *
 * Centralized here so the four Next apps stop each hand-rolling the same IIFE.
 */
export function themeInitScript(storageKey: string = THEME_STORAGE_KEY): string {
  // Keep this tiny + dependency-free; it runs before any bundle loads.
  return `(function(){try{var t=localStorage.getItem(${JSON.stringify(
    storageKey,
  )})||(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;
}
