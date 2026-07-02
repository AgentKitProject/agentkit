import { describe, it, expect } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import {
  Button,
  Card,
  Input,
  Header,
  Footer,
  AppShell,
  SiteShell,
  SidebarAccount,
  Badge,
  brandVars,
  BRAND_ACCENTS,
  ThemeToggle,
  themeInitScript,
  THEME_STORAGE_KEY,
} from "../src/index.js";

describe("Button", () => {
  it("renders primary variant by default as a <button>", () => {
    render(<Button>Click</Button>);
    const btn = screen.getByRole("button", { name: "Click" });
    expect(btn).toHaveClass("ak-btn", "ak-btn--primary", "ak-btn--md");
  });

  it("renders secondary and ghost variants", () => {
    const { rerender } = render(<Button variant="secondary">S</Button>);
    expect(screen.getByRole("button")).toHaveClass("ak-btn--secondary");
    rerender(<Button variant="ghost">G</Button>);
    expect(screen.getByRole("button")).toHaveClass("ak-btn--ghost");
  });

  it("renders an <a> when href is provided", () => {
    render(<Button href="/go">Link</Button>);
    const link = screen.getByRole("link", { name: "Link" });
    expect(link).toHaveAttribute("href", "/go");
    expect(link).toHaveClass("ak-btn");
  });

  it("is disabled when loading", () => {
    render(<Button loading>Wait</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
  });
});

describe("Card", () => {
  it("renders children and title header", () => {
    render(<Card title="Hello">Body</Card>);
    expect(screen.getByText("Hello")).toHaveClass("ak-card__title");
    expect(screen.getByText("Body")).toBeInTheDocument();
  });
});

describe("Input", () => {
  it("renders with an associated label", () => {
    render(<Input label="Name" id="name" />);
    const input = screen.getByLabelText("Name");
    expect(input).toHaveClass("ak-input");
  });
});

describe("Badge", () => {
  it("renders tone classes", () => {
    render(<Badge tone="success">ok</Badge>);
    expect(screen.getByText("ok")).toHaveClass("ak-badge", "ak-badge--success");
  });
});

describe("Header", () => {
  it("renders nav items, logo and account slots", () => {
    render(
      <Header
        logo={<span>LOGO</span>}
        account={<span>Account</span>}
        nav={[
          { label: "Catalog", href: "/catalog", active: true },
          { label: "Docs", href: "/docs" },
          { label: "GitHub", href: "https://gh", external: true },
        ]}
      />,
    );
    expect(screen.getByText("LOGO")).toBeInTheDocument();
    expect(screen.getByText("Account")).toBeInTheDocument();
    // Nav renders twice (desktop + mobile menu); scope to the primary <nav>.
    const primary = screen.getByRole("navigation", { name: "Primary" });
    const active = within(primary).getByRole("link", { name: "Catalog" });
    expect(active).toHaveClass("ak-header__nav-link--active");
    const ext = within(primary).getByRole("link", { name: "GitHub" });
    expect(ext).toHaveAttribute("target", "_blank");
  });

  it("static nav items open in same tab; external web-app items open in new tab", () => {
    // Mirrors DEFAULT_NAV: static/marketing items have no external flag,
    // web-app destinations (Forge, Auto, Account) are external: true.
    render(
      <Header
        nav={[
          { label: "Home", href: "https://agentkitproject.com" },
          { label: "Market", href: "https://market.agentkitproject.com" },
          { label: "Docs", href: "https://docs.agentkitproject.com" },
          { label: "Roadmap", href: "https://agentkitproject.com/roadmap" },
          { label: "Forge", href: "https://forge.agentkitproject.com", external: true },
          { label: "Auto", href: "https://auto.agentkitproject.com", external: true },
          { label: "Account", href: "https://profile.agentkitproject.com", external: true },
        ]}
      />,
    );
    const primary = screen.getByRole("navigation", { name: "Primary" });
    // Static/marketing items: same-tab navigation (no target attribute).
    for (const label of ["Home", "Market", "Docs", "Roadmap"]) {
      const link = within(primary).getByRole("link", { name: label });
      expect(link).not.toHaveAttribute("target");
    }
    // Web-app items: new-tab navigation.
    for (const label of ["Forge", "Auto", "Account"]) {
      const link = within(primary).getByRole("link", { name: label });
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noreferrer noopener");
    }
  });
});

describe("Footer", () => {
  it("renders ecosystem + legal links and contact", () => {
    render(<Footer brandTitle="Market" brandSubtitle="Find kits" />);
    // Ecosystem
    expect(screen.getByRole("link", { name: "Market" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Forge" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Roadmap" })).toBeInTheDocument();
    // Legal
    expect(screen.getByRole("link", { name: "Privacy" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Kit License" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Security" })).toBeInTheDocument();
    // Contact (hyphenated domain, intentional)
    expect(
      screen.getByText("hello@agentkit-project.com"),
    ).toHaveAttribute("href", "mailto:hello@agentkit-project.com");
    expect(screen.getByText("© 2026 AgentKitProject")).toBeInTheDocument();
  });
});

describe("AppShell (sidebar app layout — desktop Forge)", () => {
  it("renders the sidebar rail, nav rail items, topbar title, content + brand var", () => {
    const { container } = render(
      <AppShell
        logo={<span>L</span>}
        brand="Forge"
        brandSubtitle="Desktop Forge"
        brandAccent="#0fb3d1"
        eyebrow="Agent Kit workspace"
        title="My Kits"
        nav={[
          { label: "My Kits", href: "/kits", active: true },
          { label: "Build", onClick: () => {} },
        ]}
        account={<SidebarAccount name="Ada" status="Signed in" initials="A" />}
      >
        <div>main content</div>
      </AppShell>,
    );
    expect(screen.getByText("main content")).toBeInTheDocument();
    // Sidebar app layout (not the site .ak-shell).
    const app = container.querySelector(".ak-app") as HTMLElement;
    expect(app).not.toBeNull();
    expect(app.style.getPropertyValue("--ak-brand")).toBe("#0fb3d1");
    expect(container.querySelector(".ak-shell")).toBeNull();
    // Topbar title + eyebrow.
    expect(screen.getByRole("heading", { name: "My Kits" })).toBeInTheDocument();
    // Nav rail: active link + button-style item.
    const primary = screen.getByRole("navigation", { name: "Primary" });
    const active = within(primary).getByRole("link", { name: "My Kits" });
    expect(active).toHaveClass("ak-nav-item--active");
    expect(active).toHaveAttribute("aria-current", "page");
    expect(within(primary).getByRole("button", { name: "Build" })).toHaveClass(
      "ak-nav-item",
    );
    // Account block.
    expect(screen.getByText("Ada")).toHaveClass("ak-sidebar__account-name");
    // Skip link present.
    expect(
      screen.getByRole("link", { name: "Skip to content" }),
    ).toHaveAttribute("href", "#ak-main-content");
  });

  it("layout='site' delegates to the SiteShell web chrome", () => {
    const { container } = render(
      <AppShell
        layout="site"
        logo={<span>L</span>}
        brand="Market"
        brandAccent="#0fb3d1"
        nav={[{ label: "Catalog", href: "/c", active: true }]}
      >
        <div>site content</div>
      </AppShell>,
    );
    expect(screen.getByText("site content")).toBeInTheDocument();
    const shell = container.querySelector(".ak-shell") as HTMLElement;
    expect(shell).not.toBeNull();
    expect(shell.style.getPropertyValue("--ak-brand")).toBe("#0fb3d1");
    expect(container.querySelector(".ak-app")).toBeNull();
  });
});

describe("SiteShell (web chrome)", () => {
  it("renders Header nav + Footer and applies brand accent var", () => {
    const { container } = render(
      <SiteShell
        logo={<span>L</span>}
        brand="Market"
        brandAccent="#0fb3d1"
        nav={[{ label: "Catalog", href: "/c", active: true }]}
        footer={{ brandTitle: "AgentKit Market" }}
      >
        <div>site content</div>
      </SiteShell>,
    );
    expect(screen.getByText("site content")).toBeInTheDocument();
    const shell = container.querySelector(".ak-shell") as HTMLElement;
    expect(shell.style.getPropertyValue("--ak-brand")).toBe("#0fb3d1");
    expect(
      screen.getByRole("contentinfo"),
    ).toBeInTheDocument(); // footer
  });
});

describe("SidebarAccount", () => {
  it("renders initials avatar, name, status and is a button by default", () => {
    render(<SidebarAccount name="Grace" status="Online" initials="GH" />);
    const btn = screen.getByRole("button");
    expect(btn).toHaveClass("ak-sidebar__account");
    expect(screen.getByText("Grace")).toHaveClass("ak-sidebar__account-name");
    expect(screen.getByText("Online")).toHaveClass(
      "ak-sidebar__account-status",
    );
    expect(screen.getByText("GH")).toHaveClass("ak-sidebar__account-avatar");
  });

  it("renders an <a> when href is provided", () => {
    render(<SidebarAccount name="Grace" href="/account" />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/account");
  });
});

describe("brandVars", () => {
  it("sets the three brand vars", () => {
    const v = brandVars("#16a34a") as Record<string, string>;
    expect(v["--ak-brand"]).toBe("#16a34a");
    expect(v["--ak-brand-strong"]).toBe("#16a34a");
    expect(v["--ak-brand-soft"]).toContain("color-mix");
  });
});

describe("BRAND_ACCENTS", () => {
  it("exposes the canonical per-app accents", () => {
    expect(BRAND_ACCENTS.forge).toEqual({
      accent: "#4f46e5",
      strong: "#4338ca",
    });
    expect(BRAND_ACCENTS.market.accent).toBe("#0fb3d1");
    expect(BRAND_ACCENTS.auto.accent).toBe("#16a34a");
    expect(BRAND_ACCENTS.profile.accent).toBe("#2f8f89");
    expect(BRAND_ACCENTS.site.accent).toBe("#6d46e9");
  });
});

describe("themeInitScript", () => {
  it("references the shared storage key and prefers-color-scheme fallback", () => {
    const s = themeInitScript();
    expect(THEME_STORAGE_KEY).toBe("akf-theme");
    expect(s).toContain('"akf-theme"');
    expect(s).toContain("prefers-color-scheme: dark");
    expect(s).toContain('setAttribute("data-theme"');
  });
});

describe("ThemeToggle", () => {
  it("renders an icon button by default and flips data-theme on click", () => {
    document.documentElement.removeAttribute("data-theme");
    render(<ThemeToggle />);
    const btn = screen.getByRole("button", { name: /switch to dark mode/i });
    expect(btn).toHaveClass("ak-theme-toggle");
    fireEvent.click(btn);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    // The label flips to offer the reverse action.
    expect(
      screen.getByRole("button", { name: /switch to light mode/i }),
    ).toBeInTheDocument();
  });

  it("renders the nav variant as a labeled .ak-nav-item row", () => {
    render(<ThemeToggle variant="nav" />);
    const btn = screen.getByRole("button", { name: /switch to/i });
    expect(btn).toHaveClass("ak-nav-item", "ak-theme-toggle--nav");
    expect(
      btn.querySelector(".ak-nav-item__label")?.textContent,
    ).toMatch(/mode/i);
  });
});

describe("Shells: built-in themeToggle slot", () => {
  it("SiteShell renders the icon toggle when themeToggle is set", () => {
    const { container } = render(
      <SiteShell themeToggle account={<span>acct</span>}>
        <div>c</div>
      </SiteShell>,
    );
    expect(container.querySelector(".ak-theme-toggle")).not.toBeNull();
    expect(container.querySelector(".ak-header__account-cluster")).not.toBeNull();
  });

  it("AppShell renders the nav toggle in the sidebar footer when set", () => {
    const { container } = render(
      <AppShell themeToggle nav={[{ label: "X", onClick: () => {} }]}>
        <div>c</div>
      </AppShell>,
    );
    const foot = container.querySelector(".ak-sidebar__foot");
    expect(foot).not.toBeNull();
    expect(foot?.querySelector(".ak-theme-toggle--nav")).not.toBeNull();
  });
});
