import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import { SiteChrome } from "@/components/SiteChrome";
import { themeInitScript, sidebarInitScript } from "@agentkitforge/ui";
import { getCurrentUser, isAdminRole } from "@/lib/auth";
import { isSelfHost, getEcosystemLinks } from "@/lib/self-host";
// Shared UI framework stylesheet (tokens + SiteShell + primitives), imported
// first so app-specific rules in globals.css layer on top and the legacy
// --market-* token bridge resolves against the framework's --ak-* defaults.
import "@agentkitforge/ui/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://market.agentkitproject.com"),
  title: "AgentKitMarket",
  description: "Discovery, publishing, validation, review, and distribution for Agent Kits.",
  openGraph: {
    siteName: "AgentKitMarket",
    type: "website",
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "AgentKitMarket" }],
  },
  twitter: { card: "summary_large_image", images: ["/og.png"] },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16.png", type: "image/png", sizes: "16x16" },
      { url: "/brand/agentkitmarket-icon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

// Set data-theme BEFORE React hydrates (no flash), from the same source the
// shell's built-in ThemeToggle reads. Centralized in @agentkitforge/ui.
const THEME_INIT_SCRIPT = themeInitScript();
const SIDEBAR_INIT_SCRIPT = sidebarInitScript();

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const user = await getCurrentUser();
  const showAdmin = isAdminRole(user?.role);
  // Resolved at request time (honors runtime env, not build-time NEXT_PUBLIC_*
  // baking) so the top nav drops the hosted ecosystem tabs on a self-host instance.
  const selfHost = isSelfHost();
  const ecosystemLinks = getEcosystemLinks();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: SIDEBAR_INIT_SCRIPT }} />
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script defer src="https://analytics.agentkitproject.com/script.js" data-website-id="9682fe00-aa23-4345-b1a7-8dc7f6ab7364" data-domains="agentkitproject.com,market.agentkitproject.com,profile.agentkitproject.com,auto.agentkitproject.com,webapp.forge.agentkitproject.com" />
      </head>
      <body>
        <AuthKitProvider>
          <SiteChrome
            signedIn={Boolean(user)}
            userEmail={user?.email}
            showAdmin={showAdmin}
            selfHost={selfHost}
            ecosystemLinks={ecosystemLinks}
          >
            {children}
          </SiteChrome>
        </AuthKitProvider>
      </body>
    </html>
  );
}
