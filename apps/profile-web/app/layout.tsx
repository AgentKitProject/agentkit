import type { Metadata } from "next";
import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import { SiteChrome } from "@/components/SiteChrome";
import { themeInitScript } from "@agentkitforge/ui";
import "./globals.css";

// Set data-theme BEFORE React hydrates (no flash), from the same source the
// shell's built-in ThemeToggle reads. Centralized in @agentkitforge/ui;
// suppressHydrationWarning on <html> because it only touches the attribute.
const THEME_INIT_SCRIPT = themeInitScript();

export const metadata: Metadata = {
  metadataBase: new URL("https://profile.agentkitproject.com"),
  title: "AgentKitProject Account",
  description: "Manage your AgentKitProject profile and product access.",
  manifest: "/site.webmanifest",
  openGraph: {
    siteName: "AgentKitProject",
    type: "website",
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "AgentKitProject Account" }],
  },
  twitter: { card: "summary_large_image", images: ["/og.png"] },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16.png", type: "image/png", sizes: "16x16" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script defer src="https://analytics.agentkitproject.com/script.js" data-website-id="9682fe00-aa23-4345-b1a7-8dc7f6ab7364" data-domains="agentkitproject.com,market.agentkitproject.com,profile.agentkitproject.com,auto.agentkitproject.com,webapp.forge.agentkitproject.com" />
      </head>
      <body>
        <AuthKitProvider>
          <SiteChrome>{children}</SiteChrome>
        </AuthKitProvider>
      </body>
    </html>
  );
}
