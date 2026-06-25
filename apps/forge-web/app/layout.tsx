import type { ReactNode } from "react";
import { themeInitScript } from "@agentkitforge/ui";
// Shared UI framework stylesheet (tokens + AppShell/SiteShell + primitives).
// Imported first so app-specific rules in forge.css can layer on top and the
// token bridge (--color-* → --ak-*) resolves against the framework defaults.
import "@agentkitforge/ui/styles.css";
import "./forge.css";

export const metadata = {
  metadataBase: new URL("https://forge.agentkitproject.com"),
  title: "AgentKitForge Web",
  description: "Build and run portable Agent Kits in your browser.",
  openGraph: {
    siteName: "AgentKitForge Web",
    type: "website",
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Web Forge" }]
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
