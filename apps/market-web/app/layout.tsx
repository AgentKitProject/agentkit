import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import { SiteChrome } from "@/components/SiteChrome";
import { getCurrentUser, isAdminRole } from "@/lib/auth";
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

// Set data-theme BEFORE React hydrates, from the same source the ThemeToggle
// reads (localStorage "akf-theme", else the OS preference), so the page paints
// in the correct theme with no flash. Mirrors agentkitforge-web / auto-web.
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("akf-theme")||(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const user = await getCurrentUser();
  const showAdmin = isAdminRole(user?.role);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <AuthKitProvider>
          <SiteChrome signedIn={Boolean(user)} showAdmin={showAdmin}>
            {children}
          </SiteChrome>
        </AuthKitProvider>
      </body>
    </html>
  );
}
