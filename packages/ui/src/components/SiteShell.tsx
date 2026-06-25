"use client";

import * as React from "react";
import { Header, type HeaderProps } from "./Header.js";
import { Footer, type FooterProps } from "./Footer.js";
import { brandVars } from "../brand.js";

/**
 * SiteShell — top-chrome web layout (sticky Header + Footer) for marketing
 * and catalog surfaces (project-site, Market landing). For app surfaces
 * (Forge, Auto, account dashboards) prefer the sidebar `AppShell`.
 *
 * This was the original `AppShell`; that name now maps to the sidebar layout,
 * with a back-compat `layout="site"` escape hatch documented there.
 */
export type SiteShellProps = {
  /** Logo slot passed through to Header. */
  logo?: React.ReactNode;
  /** Brand label passed through to Header. */
  brand?: string;
  /** Nav passed through to Header (array form). */
  nav?: HeaderProps["nav"];
  /** Custom nav nodes (alternative to `nav`). */
  navChildren?: React.ReactNode;
  /** Account / sign-in slot passed through to Header. */
  account?: React.ReactNode;
  /** Footer props. */
  footer?: FooterProps;
  /**
   * One-prop rebrand: sets --ak-brand / --ak-brand-strong / --ak-brand-soft
   * on the shell root. Pass just an accent, or full control via the object.
   */
  brandAccent?: string;
  brandAccentStrong?: string;
  brandAccentSoft?: string;
  /** Main-content id for the skip link target. */
  contentId?: string;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
};

export function SiteShell({
  logo,
  brand,
  nav,
  navChildren,
  account,
  footer,
  brandAccent,
  brandAccentStrong,
  brandAccentSoft,
  contentId = "ak-main-content",
  className,
  style,
  children,
}: SiteShellProps) {
  const accentStyle = brandAccent
    ? brandVars(brandAccent, brandAccentStrong, brandAccentSoft)
    : undefined;

  return (
    <div
      className={["ak-shell", className].filter(Boolean).join(" ")}
      style={{ ...accentStyle, ...style }}
    >
      <a className="ak-skip-link" href={`#${contentId}`}>
        Skip to content
      </a>

      <Header logo={logo} brand={brand} nav={nav} account={account}>
        {navChildren}
      </Header>

      <main id={contentId} className="ak-main">
        <div className="ak-main__inner">{children}</div>
      </main>

      <Footer {...footer} />
    </div>
  );
}
