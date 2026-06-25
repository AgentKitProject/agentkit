"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Dark-mode toggle, self-contained so it can drop into SiteShell's `account`
 * slot. Persists to localStorage "akf-theme" — the same key the pre-paint
 * inline script in app/layout.tsx reads — and flips data-theme on <html>, which
 * the @agentkitforge/ui framework keys its dark tokens off of.
 *
 * State defaults to "light" on the FIRST render (server + client) so the
 * server-rendered markup matches the client's initial render (no React #418
 * hydration mismatch). The real persisted/system theme is read AFTER mount; the
 * inline layout script has already set the correct data-theme pre-paint, so we
 * skip applying the placeholder render to avoid a one-frame flash.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<string>("light");

  useEffect(() => {
    const saved =
      localStorage.getItem("akf-theme") ??
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    setTheme(saved);
  }, []);

  const synced = useRef(false);
  useEffect(() => {
    if (!synced.current) {
      synced.current = true;
      return;
    }
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("akf-theme", theme);
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        height: "2.1rem",
        width: "2.1rem",
        padding: 0,
        cursor: "pointer",
        lineHeight: 1,
        borderRadius: "var(--ak-radius-control, 10px)",
        border: "1px solid var(--ak-border, #cbd5e1)",
        background: "var(--ak-surface, #ffffff)",
        color: "var(--ak-text, #0f172a)",
      }}
    >
      {isDark ? (
        // Sun
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        // Moon
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
