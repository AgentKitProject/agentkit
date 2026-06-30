"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  SiteShell,
  DEFAULT_FOOTER_LINKS,
  navWithActive,
  BRAND_ACCENTS,
  type NavItem,
} from "@agentkitforge/ui";
import type { EcosystemLinks } from "@/lib/self-host";

export type SiteChromeProps = {
  /** Whether a user is signed in (resolved server-side). */
  signedIn: boolean;
  /** Whether the signed-in user has an admin role. */
  showAdmin: boolean;
  /**
   * True when this is a self-hosted instance. Resolved server-side. When set, the
   * canonical *.agentkitproject.com ecosystem tabs are dropped from the top nav
   * (and the hosted Account link from the dropdown) so a self-host instance never
   * points users back into our hosted ecosystem.
   */
  selfHost?: boolean;
  /**
   * Cross-ecosystem link bases (resolved server-side). On hosted these are the
   * public *.agentkitproject.com URLs; on self-host only operator-configured ones
   * are present (others undefined → the tab is hidden).
   */
  ecosystemLinks?: EcosystemLinks;
  children: ReactNode;
};

/**
 * Account dropdown rendered into the SiteShell header account slot when signed in.
 * Contains personal/account-scoped items: My Submissions, My Purchases, Admin (admin only),
 * Account profile link, and Sign out. These are removed from the inline nav to reduce clutter.
 */
function AccountDropdown({ showAdmin, profileUrl }: { showAdmin: boolean; profileUrl?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape key.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, []);

  return (
    <div className="account-dropdown" ref={ref}>
      <button
        className="account-dropdown__trigger"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="account-dropdown__label">Account</span>
        <span className="account-dropdown__chevron" aria-hidden>
          {open ? "▲" : "▼"}
        </span>
      </button>
      {open && (
        <div className="account-dropdown__menu" role="menu">
          <Link
            className="account-dropdown__item"
            href="/submissions"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            My Submissions
          </Link>
          <Link
            className="account-dropdown__item"
            href="/purchases"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            My Purchases
          </Link>
          {showAdmin && (
            <Link
              className="account-dropdown__item account-dropdown__item--admin"
              href="/admin"
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              Admin
            </Link>
          )}
          <div className="account-dropdown__divider" role="separator" />
          {/* Profile is a hosted (or operator-configured) service — hidden on a
              self-host instance that has no profile URL. */}
          {profileUrl && (
            <a
              className="account-dropdown__item"
              href={profileUrl}
              target="_blank"
              rel="noreferrer noopener"
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              AgentKitProject Account ↗
            </a>
          )}
          {/* Plain <a> ensures sign-out is a full-page navigation (not client-side routing). */}
          <a
            className="account-dropdown__item account-dropdown__item--signout"
            href="/auth/sign-out"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            Sign out
          </a>
        </div>
      )}
    </div>
  );
}

/**
 * Market top-chrome built on the shared `@agentkitforge/ui` SiteShell.
 * Auth state is resolved server-side and passed in as props so this stays a
 * thin client wrapper (SiteShell is a client component).
 *
 * Inline nav: canonical ecosystem tabs + Kits + Submit Kit (public/catalog-level).
 * Account dropdown: My Submissions, My Purchases, Admin (admin only), Account, Sign out.
 */
export function SiteChrome({
  signedIn,
  showAdmin,
  selfHost = false,
  ecosystemLinks,
  children,
}: SiteChromeProps) {
  const links = ecosystemLinks ?? {};

  // Self-host: drop the canonical *.agentkitproject.com ecosystem tabs entirely;
  // surface only this Market's local catalog routes plus any sibling apps the
  // operator explicitly configured (NEXT_PUBLIC_FORGE_URL / NEXT_PUBLIC_AUTO_URL).
  // Hosted: the full canonical ecosystem nav (Market tab active) + local routes.
  const nav: NavItem[] = selfHost
    ? [
        { label: "Kits", href: "/kits" },
        { label: "Submit Kit", href: "/submit" },
        ...(links.forgeUrl
          ? [{ label: "Web Forge", href: links.forgeUrl, external: true }]
          : []),
        ...(links.autoUrl
          ? [{ label: "Auto", href: links.autoUrl, external: true }]
          : []),
        ...(links.docsUrl
          ? [{ label: "Docs", href: links.docsUrl, external: true }]
          : []),
      ]
    : [
        // Canonical ecosystem nav — Market tab marked active.
        ...navWithActive("Market"),
        // Market-specific catalog items appended after the canonical set.
        { label: "Kits", href: "/kits" },
        { label: "Submit Kit", href: "/submit" },
      ];

  // The header dark-mode toggle is now the shell's built-in `themeToggle`.
  const account = signedIn ? (
    <AccountDropdown showAdmin={showAdmin} profileUrl={links.profileUrl} />
  ) : (
    <Link className="ak-btn ak-btn--secondary ak-btn--sm" href="/auth/sign-in">
      Sign in / Create account
    </Link>
  );

  return (
    <SiteShell
      themeToggle
      logo={
        <Link href="/" aria-label="AgentKitMarket home" style={{ display: "inline-flex" }}>
          <Image
            src="/brand/agentkitmarket-logo.svg"
            alt="AgentKitMarket"
            width={193}
            height={42}
            priority
          />
        </Link>
      }
      nav={nav}
      account={account}
      brandAccent={BRAND_ACCENTS.market.accent}
      brandAccentStrong={BRAND_ACCENTS.market.strong}
      footer={{
        brandTitle: "AgentKitMarket",
        brandSubtitle: "Public discovery, review, and distribution for reusable Agent Kits.",
        links: {
          ...DEFAULT_FOOTER_LINKS,
          legal: [
            ...DEFAULT_FOOTER_LINKS.legal,
            {
              label: "Report a listing",
              href: "mailto:hello@agentkit-project.com?subject=AgentKitMarket%20listing%20report",
            },
          ],
        },
      }}
    >
      {children}
    </SiteShell>
  );
}
