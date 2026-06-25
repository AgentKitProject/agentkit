import type { Metadata } from "next";
import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import { SiteChrome } from "@/components/SiteChrome";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://profile.agentkitproject.com"),
  title: "AgentKitProject Account",
  description: "Manage your AgentKitProject profile and product access.",
  manifest: "/site.webmanifest",
  openGraph: {
    siteName: "AgentKitProject",
    type: "website",
    locale: "en_US",
  },
  twitter: { card: "summary" },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
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
    <html lang="en">
      <body>
        <AuthKitProvider>
          <SiteChrome>{children}</SiteChrome>
        </AuthKitProvider>
      </body>
    </html>
  );
}
