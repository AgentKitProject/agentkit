import type { ReactNode } from "react";
import type { Metadata } from "next";
// Shared UI framework stylesheet (tokens + AppShell + primitives). Imported
// first so app-specific rules in forge.css layer on top and the token bridge
// (--color-* → --ak-*) resolves against the framework defaults.
import "@agentkitforge/ui/styles.css";
import "./forge.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://auto.agentkitproject.com"),
  title: "AgentKitAuto",
  description: "Autonomous Agent Kit runs — on-demand, scheduled, and webhook-triggered.",
  openGraph: {
    siteName: "AgentKitAuto",
    type: "website",
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "AgentKitAuto" }],
  },
  twitter: { card: "summary_large_image", images: ["/og.png"] },
  icons: {
    icon: [
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16.png", type: "image/png", sizes: "16x16" },
      { url: "/auto-logo.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
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
