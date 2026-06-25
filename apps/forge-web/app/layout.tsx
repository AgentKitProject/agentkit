import type { ReactNode } from "react";
// Shared UI framework stylesheet (tokens + AppShell/SiteShell + primitives).
// Imported first so app-specific rules in forge.css can layer on top and the
// token bridge (--color-* → --ak-*) resolves against the framework defaults.
import "@agentkitforge/ui/styles.css";
import "./forge.css";

export const metadata = {
  title: "AgentKitForge Web",
  description: "Web backend for the AgentKitForge ecosystem"
};

// Set data-theme BEFORE React hydrates, from the same source useTheme reads
// (localStorage "akf-theme", else the OS preference), so the page paints in the
// correct theme with no flash. React state still starts "light" on first render
// (matching SSR) and corrects post-mount, so this only touches the <html>
// attribute — hence suppressHydrationWarning on <html>.
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("akf-theme")||(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
