"use client";

import { useState, useEffect, useRef } from "react";

// Persisted theme key shared across the ecosystem apps (forge-web, auto-web,
// site). The inline script in app/layout.tsx reads this same key pre-paint to
// set data-theme before hydration, so this toggle only owns flips afterward.
const THEME_KEY = "akf-theme";

/**
 * Small header theme toggle rendered into the SiteShell `account` slot. Flips
 * the `data-theme` attribute on <html> between "dark" and "light", persisting
 * the choice to localStorage. The framework chrome (SiteShell header/footer/
 * buttons/cards) reacts to the attribute via the shared @agentkitforge/ui dark
 * tokens, so no extra wiring is needed.
 */
export function ThemeToggle() {
  // Start "light" on first render to match SSR (the inline layout script has
  // already set the correct data-theme pre-paint). Read the real value after
  // mount to avoid a hydration mismatch.
  const [theme, setTheme] = useState<string>("light");

  // Skip applying state on the first render: the inline script already set the
  // correct pre-paint theme, so writing "light" here would cause a one-frame
  // flash. Sync the attribute/localStorage on every change after mount.
  const synced = useRef(false);

  useEffect(() => {
    const current =
      document.documentElement.getAttribute("data-theme") ||
      localStorage.getItem(THEME_KEY) ||
      "light";
    setTheme(current);
  }, []);

  useEffect(() => {
    if (!synced.current) {
      synced.current = true;
      return;
    }
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // localStorage may be unavailable (private mode); the in-memory toggle
      // still works for the session.
    }
  }, [theme]);

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      title={`Switch to ${isDark ? "light" : "dark"} mode`}
      aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
    >
      {isDark ? <SunIcon size={18} /> : <MoonIcon size={18} />}
    </button>
  );
}

// Minimal inline theme icons to avoid adding a dependency. Style matches the
// SidebarAccount/forge-web sun-moon SVGs.
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
