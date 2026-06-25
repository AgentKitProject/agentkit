"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { THEME_STORAGE_KEY, type Theme } from "./theme.js";

/**
 * Shared theme hook used by `ThemeToggle`. Owns the FOUC-safe pattern the apps
 * each previously re-implemented:
 *  - first render returns "light" on BOTH server and client so the SSR markup
 *    matches the client's initial render (no React #418 hydration mismatch);
 *  - the real persisted/OS theme is read AFTER mount (a pure client update);
 *  - the placeholder first render is NOT written back to <html>/localStorage,
 *    so the correct pre-paint theme set by `themeInitScript` isn't clobbered
 *    (no one-frame flash). Every change after mount syncs both.
 */
export function useTheme(
  storageKey: string = THEME_STORAGE_KEY,
): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    let saved: Theme = "light";
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored === "dark" || stored === "light") {
        saved = stored;
      } else if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        saved = "dark";
      }
    } catch {
      // localStorage/matchMedia may be unavailable; keep "light".
    }
    setTheme(saved);
  }, [storageKey]);

  const synced = useRef(false);
  useEffect(() => {
    if (!synced.current) {
      synced.current = true;
      return;
    }
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(storageKey, theme);
    } catch {
      // localStorage may be unavailable (private mode); the in-memory toggle
      // still works for the session.
    }
  }, [theme, storageKey]);

  const toggle = useCallback(
    () => setTheme((t) => (t === "dark" ? "light" : "dark")),
    [],
  );

  return [theme, toggle];
}
