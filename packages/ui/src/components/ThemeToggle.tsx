"use client";

import * as React from "react";
import { useTheme } from "../use-theme.js";

/**
 * Visual style of the toggle:
 *  - `"icon"`  — a compact square icon button. Use in the SiteShell header
 *                account area (Market, Profile).
 *  - `"nav"`   — a labeled `.ak-nav-item` row ("Light mode" / "Dark mode" +
 *                icon). Use in the AppShell sidebar footer (Forge, Auto).
 */
export type ThemeToggleVariant = "icon" | "nav";

export type ThemeToggleProps = {
  /** Visual style. Defaults to `"icon"`. */
  variant?: ThemeToggleVariant;
  /** localStorage key override (defaults to the shared `akf-theme`). */
  storageKey?: string;
  className?: string;
};

/**
 * Reusable dark-mode toggle for the AgentKitProject ecosystem. Flips
 * `data-theme` on <html> between "light" and "dark", persisting the choice to
 * localStorage (shared `akf-theme` key) — the same key the FOUC-free
 * `themeInitScript` reads pre-paint. The framework chrome reacts to the
 * attribute via the shared dark tokens, so no extra wiring is needed.
 *
 * Apps no longer ship their own toggle: pass `themeToggle` to `SiteShell` /
 * `AppShell` (which render this), or mount it directly.
 */
export function ThemeToggle({
  variant = "icon",
  storageKey,
  className,
}: ThemeToggleProps) {
  const [theme, toggle] = useTheme(storageKey);
  const isDark = theme === "dark";
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";

  if (variant === "nav") {
    return (
      <button
        type="button"
        className={["ak-theme-toggle--nav", "ak-nav-item", className]
          .filter(Boolean)
          .join(" ")}
        onClick={toggle}
        title={label}
        aria-label={label}
      >
        <span className="ak-nav-item__icon" aria-hidden="true">
          {isDark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
        </span>
        <span className="ak-nav-item__label">
          {isDark ? "Light mode" : "Dark mode"}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={["ak-theme-toggle", className].filter(Boolean).join(" ")}
      onClick={toggle}
      title={label}
      aria-label={label}
    >
      {isDark ? <SunIcon size={18} /> : <MoonIcon size={18} />}
    </button>
  );
}

// Minimal inline icons (no dependency); matches the desktop Forge sun/moon SVGs.
function SunIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="3.5" />
      <line x1="10" y1="2" x2="10" y2="4" />
      <line x1="10" y1="16" x2="10" y2="18" />
      <line x1="2" y1="10" x2="4" y2="10" />
      <line x1="16" y1="10" x2="18" y2="10" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="14.36" y1="14.36" x2="15.78" y2="15.78" />
      <line x1="4.22" y1="15.78" x2="5.64" y2="14.36" />
      <line x1="14.36" y1="5.64" x2="15.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="M17 11.5A7 7 0 1 1 8.5 3a5.5 5.5 0 1 0 8.5 8.5z" />
    </svg>
  );
}
