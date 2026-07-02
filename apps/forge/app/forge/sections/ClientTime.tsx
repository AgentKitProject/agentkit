"use client";

/**
 * ClientTime — renders a timestamp without SSR/client hydration mismatch.
 *
 * The root cause of React #418 on the Auto page: `toLocaleString()` returns
 * a timezone/locale-specific string. The server renders in UTC with the Node
 * locale; the browser renders with the user's local timezone. The two strings
 * differ, so React's hydration comparison fails.
 *
 * Fix: render the raw ISO string on the server and during the first client
 * paint (both sides agree), then swap to the localized string after mount via
 * a `useEffect`. `suppressHydrationWarning` is belt-and-suspenders.
 */

import { useEffect, useState } from "react";

interface ClientTimeProps {
  /** ISO 8601 timestamp string, or null/undefined for an empty value. */
  ts: string | null | undefined;
  /** Rendered when ts is null/undefined/invalid. Defaults to "—". */
  fallback?: string;
}

/** Format exactly as the legacy fmtTs helper did, but only on the client. */
function formatTs(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/**
 * A small client-side time renderer that avoids SSR/hydration mismatches.
 *
 * - Server + first client paint: shows the raw ISO string (both sides match).
 * - After mount: swaps to the localized `toLocaleString()` string.
 * - `suppressHydrationWarning` silences React even if the two strings differ
 *   in edge cases (e.g. a fast-hydrating client that beats the effect).
 */
export function ClientTime({ ts, fallback = "—" }: ClientTimeProps) {
  // Start with the ISO string so SSR output === first-client-render output.
  const [display, setDisplay] = useState<string>(() => {
    if (!ts) return fallback;
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? fallback : ts;
  });

  useEffect(() => {
    if (!ts) {
      setDisplay(fallback);
      return;
    }
    setDisplay(formatTs(ts));
  }, [ts, fallback]);

  // suppressHydrationWarning: belt-and-suspenders in case the effect fires
  // before React finishes comparing (shouldn't happen, but safe to have).
  return <time dateTime={ts ?? undefined} suppressHydrationWarning>{display}</time>;
}
