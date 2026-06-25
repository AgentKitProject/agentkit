export { Button } from "./components/Button.js";
export type {
  ButtonProps,
  ButtonVariant,
  ButtonSize,
} from "./components/Button.js";

export { Card } from "./components/Card.js";
export type { CardProps } from "./components/Card.js";

export {
  Field,
  Label,
  Input,
  Textarea,
  Select,
} from "./components/Field.js";
export type {
  LabelProps,
  InputProps,
  TextareaProps,
  SelectProps,
} from "./components/Field.js";

export { Badge, Pill } from "./components/Badge.js";
export type { BadgeProps, BadgeTone, PillProps } from "./components/Badge.js";

export { DEFAULT_NAV, navWithActive } from "./nav.js";
export type { NavItem } from "./nav.js";
export { Header } from "./components/Header.js";
export type { HeaderProps } from "./components/Header.js";

export { Footer, DEFAULT_FOOTER_LINKS } from "./components/Footer.js";
export type {
  FooterProps,
  FooterLink,
  FooterLinks,
} from "./components/Footer.js";

export { SiteShell } from "./components/SiteShell.js";
export type { SiteShellProps } from "./components/SiteShell.js";

export { AppShell, SidebarAccount } from "./components/AppShell.js";
export type {
  AppShellProps,
  SidebarNavItem,
  SidebarAccountProps,
} from "./components/AppShell.js";

export { brandVars, BRAND_ACCENTS } from "./brand.js";
export type { BrandKey, BrandAccent } from "./brand.js";

export { ThemeToggle } from "./components/ThemeToggle.js";
export type {
  ThemeToggleProps,
  ThemeToggleVariant,
} from "./components/ThemeToggle.js";

export { themeInitScript, THEME_STORAGE_KEY } from "./theme.js";
export type { Theme } from "./theme.js";
export { useTheme } from "./use-theme.js";
