"use client";

import * as React from "react";

export type FooterLink = { label: string; href: string; external?: boolean };

export type FooterLinks = {
  ecosystem: FooterLink[];
  legal: FooterLink[];
  /** Contact email (intentionally hyphenated domain). */
  contactEmail: string;
};

export const DEFAULT_FOOTER_LINKS: FooterLinks = {
  ecosystem: [
    { label: "AgentKitProject", href: "https://agentkitproject.com" },
    { label: "Market", href: "https://market.agentkitproject.com" },
    { label: "Forge", href: "https://forge.agentkitproject.com" },
    {
      label: "Auto",
      href: "https://auto.agentkitproject.com",
    },
    { label: "Docs", href: "https://docs.agentkitproject.com" },
    { label: "Roadmap", href: "https://agentkitproject.com/roadmap" },
    { label: "Account", href: "https://profile.agentkitproject.com" },
    {
      label: "GitHub",
      href: "https://github.com/AgentKitProject",
      external: true,
    },
  ],
  legal: [
    { label: "Privacy", href: "https://agentkitproject.com/privacy" },
    { label: "Terms", href: "https://agentkitproject.com/terms" },
    { label: "Kit License", href: "https://agentkitproject.com/license" },
    { label: "Security", href: "https://agentkitproject.com/security" },
  ],
  contactEmail: "hello@agentkit-project.com",
};

export type FooterProps = {
  brandTitle?: string;
  brandSubtitle?: string;
  /** Override link URLs; labels/columns default to the shared ecosystem set. */
  links?: Partial<FooterLinks>;
  className?: string;
};

function LinkItem({ link }: { link: FooterLink }) {
  return (
    <li>
      <a
        className="ak-footer__link"
        href={link.href}
        {...(link.external
          ? { target: "_blank", rel: "noreferrer noopener" }
          : {})}
      >
        {link.label}
      </a>
    </li>
  );
}

export function Footer({
  brandTitle = "AgentKitProject",
  brandSubtitle,
  links,
  className,
}: FooterProps) {
  const ecosystem = links?.ecosystem ?? DEFAULT_FOOTER_LINKS.ecosystem;
  const legal = links?.legal ?? DEFAULT_FOOTER_LINKS.legal;
  const contactEmail =
    links?.contactEmail ?? DEFAULT_FOOTER_LINKS.contactEmail;

  return (
    <footer className={["ak-footer", className].filter(Boolean).join(" ")}>
      <div className="ak-footer__inner">
        <div>
          <p className="ak-footer__brand-title">{brandTitle}</p>
          {brandSubtitle ? (
            <p className="ak-footer__brand-subtitle">{brandSubtitle}</p>
          ) : null}
          <p style={{ marginTop: 12 }}>
            <a className="ak-footer__contact" href={`mailto:${contactEmail}`}>
              {contactEmail}
            </a>
          </p>
        </div>

        <div>
          <p className="ak-footer__col-title">Ecosystem</p>
          <ul className="ak-footer__links">
            {ecosystem.map((l) => (
              <LinkItem key={l.label} link={l} />
            ))}
          </ul>
        </div>

        <div>
          <p className="ak-footer__col-title">Legal</p>
          <ul className="ak-footer__links">
            {legal.map((l) => (
              <LinkItem key={l.label} link={l} />
            ))}
          </ul>
        </div>
      </div>

      <div className="ak-footer__bottom">
        <span>© 2026 AgentKitProject</span>
      </div>
    </footer>
  );
}
