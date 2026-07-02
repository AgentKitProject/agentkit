import type { ReactNode } from "react";
import { themeInitScript, sidebarInitScript } from "@agentkitforge/ui";
// Shared UI framework stylesheet (tokens + AppShell/SiteShell + primitives).
// Imported first so app-specific rules in forge.css can layer on top and the
// token bridge (--color-* → --ak-*) resolves against the framework defaults.
import "@agentkitforge/ui/styles.css";
import "./forge.css";

export const metadata = {
  metadataBase: new URL("https://webapp.forge.agentkitproject.com"),
  title: "AgentKitForge",
  description: "Build and run portable Agent Kits in your browser.",
  openGraph: {
    siteName: "AgentKitForge",
    type: "website",
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "AgentKitForge" }]
  },
  twitter: { card: "summary_large_image", images: ["/og.png"] },
  icons: {
    icon: [
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16.png", type: "image/png", sizes: "16x16" },
      { url: "/brand/agentkitforge-icon.svg", type: "image/svg+xml" }
    ],
    apple: "/apple-touch-icon.png"
  }
};

// Set data-theme BEFORE React hydrates (no flash), from the same source the
// shell's built-in ThemeToggle reads. Centralized in @agentkitforge/ui;
// suppressHydrationWarning on <html> because it only touches the attribute.
const THEME_INIT_SCRIPT = themeInitScript();
const SIDEBAR_INIT_SCRIPT = sidebarInitScript();

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: SIDEBAR_INIT_SCRIPT }} />
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script defer src="https://analytics.agentkitproject.com/script.js" data-website-id="9682fe00-aa23-4345-b1a7-8dc7f6ab7364" data-domains="agentkitproject.com,market.agentkitproject.com,profile.agentkitproject.com,auto.agentkitproject.com,webapp.forge.agentkitproject.com" />
      </head>
      <body>{children}</body>
    </html>
  );
}
