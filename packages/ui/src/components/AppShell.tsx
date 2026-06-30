"use client";

import * as React from "react";
import { brandVars } from "../brand.js";
import { SIDEBAR_ATTR, SIDEBAR_STORAGE_KEY } from "../sidebar.js";
import { SiteShell, type SiteShellProps } from "./SiteShell.js";
import { ThemeToggle } from "./ThemeToggle.js";

/**
 * A sidebar nav entry. `icon` is an optional leading node (e.g. a lucide
 * icon at 18px). Provide `href` for link navigation, or `onClick` for
 * button navigation (SPA / Tauri). `active` highlights the current item.
 */
export type SidebarNavItem = {
  label: string;
  href?: string;
  onClick?: (event: React.MouseEvent) => void;
  icon?: React.ReactNode;
  active?: boolean;
  external?: boolean;
};

export type AppShellProps = {
  /**
   * Layout family. Defaults to `"app"` — the desktop-Forge-derived sidebar
   * layout (nav rail + topbar + content). Pass `"site"` to render the
   * marketing/catalog web chrome instead (sticky Header + Footer); in that
   * mode the site-only props below are forwarded to `SiteShell`.
   */
  layout?: "app" | "site";

  /** Brand mark (logo image / svg) shown at the top of the rail. */
  logo?: React.ReactNode;
  /** Brand wordmark (e.g. "Forge"). */
  brand?: React.ReactNode;
  /** Small uppercase line under the wordmark (e.g. "Desktop Forge"). */
  brandSubtitle?: React.ReactNode;
  /** Click/href for the brand block (home). */
  brandHref?: string;
  onBrandClick?: (event: React.MouseEvent) => void;

  /** Sidebar nav, declarative. Or pass custom nodes via `navChildren`. */
  nav?: SidebarNavItem[];
  /** Custom sidebar nav nodes (alternative to `nav`). */
  navChildren?: React.ReactNode;

  /**
   * Cross-app ecosystem switcher (Forge/Market/Auto/Profile). Rendered as a
   * compact section above the primary nav so users move between apps the same
   * way in every app. Mark the current app's entry `active`. Self-host: pass
   * only the apps the operator has configured. Omit to hide the switcher.
   */
  appSwitcher?: SidebarNavItem[];

  /** Account block / extra controls pinned to the bottom of the rail. */
  account?: React.ReactNode;
  /** Extra footer slot under the account block (help links, version, …). */
  sidebarFooter?: React.ReactNode;
  /**
   * Render the built-in dark-mode `ThemeToggle` (nav variant) in the sidebar
   * footer, above any custom `sidebarFooter`. Apps no longer ship a bespoke
   * toggle. Pass `themeToggleStorageKey` to override the persisted-theme key
   * (defaults to `akf-theme`).
   */
  themeToggle?: boolean;
  themeToggleStorageKey?: string;

  /** Topbar eyebrow (uppercase, above the title). */
  eyebrow?: React.ReactNode;
  /** Topbar page title (large). */
  title?: React.ReactNode;
  /** Topbar right-aligned actions. */
  actions?: React.ReactNode;
  /** Replace the whole topbar with a custom node. */
  topbar?: React.ReactNode;

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

  /* ---- site-layout passthroughs (only used when layout="site") ---- */
  footer?: SiteShellProps["footer"];
};

export type SidebarAccountProps = {
  /** Display name / primary line. */
  name: React.ReactNode;
  /** Secondary line (status, email, handle). */
  status?: React.ReactNode;
  /** Avatar node; falls back to `initials` in a brand-tinted circle. */
  avatar?: React.ReactNode;
  initials?: string;
  href?: string;
  onClick?: (event: React.MouseEvent) => void;
  className?: string;
};

/**
 * SidebarAccount — the desktop-Forge account block (avatar + name + status)
 * pinned at the bottom of the rail. Pass to AppShell's `account` slot.
 */
export function SidebarAccount({
  name,
  status,
  avatar,
  initials,
  href,
  onClick,
  className,
}: SidebarAccountProps) {
  const inner = (
    <>
      <span className="ak-sidebar__account-avatar" aria-hidden="true">
        {avatar ?? initials ?? ""}
      </span>
      <span className="ak-sidebar__account-text">
        <span className="ak-sidebar__account-name">{name}</span>
        {status ? (
          <span className="ak-sidebar__account-status">{status}</span>
        ) : null}
      </span>
    </>
  );
  const cls = ["ak-sidebar__account", className].filter(Boolean).join(" ");
  if (href !== undefined) {
    return (
      <a className={cls} href={href} onClick={onClick}>
        {inner}
      </a>
    );
  }
  return (
    <button type="button" className={cls} onClick={onClick}>
      {inner}
    </button>
  );
}

/** Derive up-to-2-char initials from an email/name for the account avatar. */
function accountInitials(identity?: string | null): string {
  const v = (identity ?? "").trim();
  if (!v) return "AK";
  const local = v.split("@")[0] ?? v;
  const parts = local.split(/[.\-_+\s]+/).filter(Boolean);
  const chars =
    parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : local.slice(0, 2);
  return chars.toUpperCase();
}

const SIGN_OUT_ICON = (
  <svg
    viewBox="0 0 24 24"
    width={18}
    height={18}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M15 12H6m0 0l3-3m-3 3l3 3" />
    <path d="M11 4.5h6a1 1 0 011 1v13a1 1 0 01-1 1h-6" />
  </svg>
);

export type SidebarAccountFooterProps = {
  /** Signed-in identity (email/handle). Shown on the tile; falls back to "Account". */
  identity?: string | null;
  /** Optional link for the account tile (e.g. the account/settings page). */
  accountHref?: string;
  /** Optional click handler for the tile (SPA apps that switch an in-app section
   *  rather than navigating, e.g. Forge). Ignored if `accountHref` is set. */
  onAccountClick?: (event: React.MouseEvent) => void;
  /** Marks the tile active (for SPA section highlighting). */
  accountActive?: boolean;
  /** Sign-out link. Defaults to "/auth/sign-out". */
  signOutHref?: string;
};

/**
 * Standard signed-in account block for the AppShell `account` slot — IDENTICAL
 * across every app: an identity tile (avatar + identity + "Signed in") plus a
 * Sign out row. The dark/light toggle is rendered separately by AppShell's
 * `themeToggle` prop, so the account region is exactly: tile · Sign out · theme.
 * Apps must not add extra links here (keep the block uniform).
 */
export function SidebarAccountFooter({
  identity,
  accountHref,
  onAccountClick,
  accountActive,
  signOutHref = "/auth/sign-out",
}: SidebarAccountFooterProps) {
  const name = identity && identity.trim() ? identity.trim() : "Account";
  return (
    <>
      <SidebarAccount
        name={name}
        status="Signed in"
        initials={accountInitials(identity)}
        href={accountHref}
        onClick={accountHref ? undefined : onAccountClick}
        className={accountActive ? "ak-sidebar__account--active" : undefined}
      />
      <a className="ak-nav-item" href={signOutHref}>
        <span className="ak-nav-item__icon" aria-hidden="true">
          {SIGN_OUT_ICON}
        </span>
        <span className="ak-nav-item__label">Sign out</span>
      </a>
    </>
  );
}

function SidebarItem({ item }: { item: SidebarNavItem }) {
  const cls = [
    "ak-nav-item",
    item.active ? "ak-nav-item--active" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      {item.icon ? (
        <span className="ak-nav-item__icon" aria-hidden="true">
          {item.icon}
        </span>
      ) : null}
      <span className="ak-nav-item__label">{item.label}</span>
    </>
  );

  // Tooltip shows the label when the rail is collapsed (label text is hidden).
  const title = typeof item.label === "string" ? item.label : undefined;

  if (item.href !== undefined) {
    return (
      <a
        className={cls}
        href={item.href}
        title={title}
        aria-current={item.active ? "page" : undefined}
        onClick={item.onClick}
        {...(item.external
          ? { target: "_blank", rel: "noreferrer noopener" }
          : {})}
      >
        {body}
      </a>
    );
  }

  return (
    <button
      type="button"
      className={cls}
      title={title}
      aria-current={item.active ? "page" : undefined}
      onClick={item.onClick}
    >
      {body}
    </button>
  );
}

/**
 * Collapse/expand control for the sidebar. The collapsed state lives on the
 * <html> `data-ak-sidebar` attribute (set pre-paint by `sidebarInitScript` to
 * avoid a width flash) and is mirrored to localStorage; the CSS rail rules key
 * off the attribute, so toggling it is all that's needed.
 */
function SidebarCollapseToggle() {
  const [collapsed, setCollapsed] = React.useState(false);

  React.useEffect(() => {
    setCollapsed(
      document.documentElement.getAttribute(SIDEBAR_ATTR) === "collapsed",
    );
  }, []);

  const toggle = React.useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try {
        if (next) {
          document.documentElement.setAttribute(SIDEBAR_ATTR, "collapsed");
          localStorage.setItem(SIDEBAR_STORAGE_KEY, "1");
        } else {
          document.documentElement.removeAttribute(SIDEBAR_ATTR);
          localStorage.setItem(SIDEBAR_STORAGE_KEY, "0");
        }
      } catch {
        /* private mode / no storage — attribute still toggles for this session */
      }
      return next;
    });
  }, []);

  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <button
      type="button"
      className="ak-sidebar__collapse"
      onClick={toggle}
      title={label}
      aria-label={label}
    >
      <svg
        width={18}
        height={18}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={collapsed ? { transform: "rotate(180deg)" } : undefined}
      >
        <path d="M15 6l-6 6 6 6" />
      </svg>
    </button>
  );
}

/**
 * AppShell — the recommended layout for application surfaces (Forge, Auto,
 * account dashboards). Models the desktop Forge app: a sticky left nav rail
 * (brand + nav tabs + account) and a main column (topbar + content).
 *
 * Themeable via `brandAccent` (one prop) and slotted: `logo`, `brand`,
 * `nav`/`navChildren`, `account`, `sidebarFooter`, `eyebrow`/`title`/`actions`.
 *
 * Pass `layout="site"` to fall back to the marketing Header/Footer chrome
 * (delegates to `SiteShell`) — back-compat with the original AppShell.
 */
export function AppShell(props: AppShellProps) {
  const {
    layout = "app",
    logo,
    brand,
    brandSubtitle,
    brandHref,
    onBrandClick,
    nav,
    navChildren,
    appSwitcher,
    account,
    sidebarFooter,
    themeToggle,
    themeToggleStorageKey,
    eyebrow,
    title,
    actions,
    topbar,
    brandAccent,
    brandAccentStrong,
    brandAccentSoft,
    contentId = "ak-main-content",
    className,
    style,
    children,
    footer,
  } = props;

  const accentStyle = brandAccent
    ? brandVars(brandAccent, brandAccentStrong, brandAccentSoft)
    : undefined;

  if (layout === "site") {
    return (
      <SiteShell
        logo={logo}
        brand={typeof brand === "string" ? brand : undefined}
        nav={nav as SiteShellProps["nav"]}
        navChildren={navChildren}
        account={account}
        themeToggle={themeToggle}
        themeToggleStorageKey={themeToggleStorageKey}
        footer={footer}
        brandAccent={brandAccent}
        brandAccentStrong={brandAccentStrong}
        brandAccentSoft={brandAccentSoft}
        contentId={contentId}
        className={className}
        style={style}
      >
        {children}
      </SiteShell>
    );
  }

  const navNodes = nav
    ? nav.map((item) => (
        <SidebarItem key={(item.href ?? "") + item.label} item={item} />
      ))
    : navChildren;

  const brandInner = (
    <>
      {logo ? (
        <span className="ak-sidebar__brand-mark" aria-hidden="true">
          {logo}
        </span>
      ) : null}
      {brand || brandSubtitle ? (
        <span className="ak-sidebar__brand-text">
          {brand ? (
            <span className="ak-sidebar__brand-name">{brand}</span>
          ) : null}
          {brandSubtitle ? (
            <span className="ak-sidebar__brand-sub">{brandSubtitle}</span>
          ) : null}
        </span>
      ) : null}
    </>
  );

  const brandBlock =
    brandHref !== undefined ? (
      <a className="ak-sidebar__brand" href={brandHref} onClick={onBrandClick}>
        {brandInner}
      </a>
    ) : (
      <div className="ak-sidebar__brand">{brandInner}</div>
    );

  const topbarNode =
    topbar ??
    (eyebrow || title || actions ? (
      <header className="ak-topbar">
        <div className="ak-topbar__titles">
          {eyebrow ? (
            <span className="ak-topbar__eyebrow">{eyebrow}</span>
          ) : null}
          {title ? <h1 className="ak-topbar__title">{title}</h1> : null}
        </div>
        {actions ? (
          <div className="ak-topbar__actions">{actions}</div>
        ) : null}
      </header>
    ) : null);

  return (
    <div
      className={["ak-app", className].filter(Boolean).join(" ")}
      style={{ ...accentStyle, ...style }}
    >
      <a className="ak-skip-link" href={`#${contentId}`}>
        Skip to content
      </a>

      <aside className="ak-sidebar">
        <div className="ak-sidebar__header">
          {brandBlock}
          <SidebarCollapseToggle />
        </div>
        {appSwitcher && appSwitcher.length > 0 ? (
          <div className="ak-sidebar__apps" aria-label="Switch app">
            <span className="ak-sidebar__apps-label">Apps</span>
            {appSwitcher.map((item) => (
              <SidebarItem key={(item.href ?? "") + item.label} item={item} />
            ))}
          </div>
        ) : null}
        <nav className="ak-sidebar__nav" aria-label="Primary">
          {navNodes}
        </nav>
        {account || sidebarFooter || themeToggle ? (
          <div className="ak-sidebar__foot">
            {account ? (
              <div className="ak-sidebar__account-slot">{account}</div>
            ) : null}
            {themeToggle ? (
              <ThemeToggle
                variant="nav"
                storageKey={themeToggleStorageKey}
              />
            ) : null}
            {sidebarFooter}
          </div>
        ) : null}
      </aside>

      <div className="ak-app__main">
        {topbarNode}
        <main id={contentId} className="ak-app__content">
          {children}
        </main>
      </div>
    </div>
  );
}
