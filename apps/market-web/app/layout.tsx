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
  },
  twitter: { card: "summary" },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/brand/agentkitmarket-icon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const user = await getCurrentUser();
  const showAdmin = isAdminRole(user?.role);

  return (
    <html lang="en">
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
