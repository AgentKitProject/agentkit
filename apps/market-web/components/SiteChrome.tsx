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

const AGENTKIT_PROFILE_ACCOUNT_URL = "https://profile.agentkitproject.com";

export type SiteChromeProps = {
  /** Whether a user is signed in (resolved server-side). */
  signedIn: boolean;
  /** Whether the signed-in user has an admin role. */
  showAdmin: boolean;
  children: ReactNode;
};

/**
 * Account dropdown rendered into the SiteShell header account slot when signed in.
 * Contains personal/account-scoped items: My Submissions, My Purchases, Admin (admin only),
 * Account profile link, and Sign out. These are removed from the inline nav to reduce clutter.
 */
function AccountDropdown({ showAdmin }: { showAdmin: boolean }) {
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
          <a
            className="account-dropdown__item"
            href={AGENTKIT_PROFILE_ACCOUNT_URL}
            target="_blank"
            rel="noreferrer noopener"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            AgentKitProject Account ↗
          </a>
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
export function SiteChrome({ signedIn, showAdmin, children }: SiteChromeProps) {
  const nav: NavItem[] = [
    // Canonical ecosystem nav — Market tab marked active.
    ...navWithActive("Market"),
    // Market-specific catalog items appended after the canonical set.
    { label: "Kits", href: "/kits" },
    { label: "Submit Kit", href: "/submit" },
  ];

  // The header dark-mode toggle is now the shell's built-in `themeToggle`.
  const account = signedIn ? (
    <AccountDropdown showAdmin={showAdmin} />
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
