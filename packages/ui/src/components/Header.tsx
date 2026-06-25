"use client";

import * as React from "react";
import type { NavItem } from "../nav.js";

export type HeaderProps = {
  /** Logo slot (image, wordmark, link, etc.). */
  logo?: React.ReactNode;
  /** Brand label shown next to the logo when `logo` is a plain node. */
  brand?: string;
  /** Nav as a declarative array, OR pass custom nodes via `children`. */
  nav?: NavItem[];
  /** Account / sign-in slot (right side). */
  account?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
};

function NavLink({ item }: { item: NavItem }) {
  const cls = [
    "ak-header__nav-link",
    item.active ? "ak-header__nav-link--active" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <a
      className={cls}
      href={item.href}
      aria-current={item.active ? "page" : undefined}
      {...(item.external
        ? { target: "_blank", rel: "noreferrer noopener" }
        : {})}
    >
      {item.label}
    </a>
  );
}

export function Header({
  logo,
  brand,
  nav,
  account,
  children,
  className,
}: HeaderProps) {
  const [open, setOpen] = React.useState(false);

  const navNodes = nav
    ? nav.map((item) => <NavLink key={item.href + item.label} item={item} />)
    : children;

  return (
    <header
      className={["ak-header", className].filter(Boolean).join(" ")}
    >
      <div className="ak-header__inner">
        <span className="ak-header__logo">
          {logo}
          {brand ? <span>{brand}</span> : null}
        </span>

        <nav className="ak-header__nav" aria-label="Primary">
          {navNodes}
        </nav>

        <span className="ak-header__spacer" />

        {account ? <span className="ak-header__account">{account}</span> : null}

        <button
          type="button"
          className="ak-header__menu-btn"
          aria-expanded={open}
          aria-label="Toggle navigation menu"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "✕" : "☰"}
        </button>
      </div>

      <div
        className={[
          "ak-header__mobile-nav",
          open ? "ak-header__mobile-nav--open" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {navNodes}
      </div>
    </header>
  );
}
