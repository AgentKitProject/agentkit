import type { ReactNode } from "react";
import type { Metadata } from "next";
// Shared UI framework stylesheet (tokens + AppShell + primitives). Imported
// first so app-specific rules in forge.css layer on top and the token bridge
// (--color-* → --ak-*) resolves against the framework defaults.
import "@agentkitforge/ui/styles.css";
import "./forge.css";

export const metadata: Metadata = {
  title: "AgentKitAuto",
  description: "Autonomous Agent Kit runs — on-demand, scheduled, and webhook-triggered.",
  icons: {
    icon: "/agentkitauto-icon.png",
    apple: "/agentkitauto-icon.png",
  },
};

// Set data-theme BEFORE React hydrates, from the same source the framework
// useTheme hook reads (localStorage "akf-theme", else OS preference), so the
// page paints in the correct theme with no flash. Mirrors agentkitforge-web.
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
