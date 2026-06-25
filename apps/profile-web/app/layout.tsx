import type { Metadata } from "next";
import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import { SiteChrome } from "@/components/SiteChrome";
import "./globals.css";

// Set data-theme BEFORE React hydrates, from the same source the toggle reads
// (localStorage "akf-theme", else the OS preference), so the page paints in the
// correct theme with no flash. React state still starts "light" on first render
// (matching SSR) and corrects post-mount, so this only touches the <html>
// attribute — hence suppressHydrationWarning on <html>. Same recipe as the
// sibling web apps (forge-web, auto-web, apps/site).
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("akf-theme")||(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

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
      </head>
      <body>
        <AuthKitProvider>
          <SiteChrome>{children}</SiteChrome>
        </AuthKitProvider>
      </body>
    </html>
  );
}
