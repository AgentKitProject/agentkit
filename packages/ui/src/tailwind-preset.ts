/**
 * Tailwind preset that maps @agentkitforge/ui design tokens onto
 * theme.extend, referencing the CSS variables defined in styles.css.
 * Apps: `import akPreset from "@agentkitforge/ui/tailwind-preset";`
 * then `presets: [akPreset]` in tailwind.config.
 *
 * Typed loosely (no Tailwind type dep) so the package installs clean.
 */
const preset = {
  theme: {
    extend: {
      colors: {
        ink: "var(--ak-text)",
        surface: {
          DEFAULT: "var(--ak-surface)",
          muted: "var(--ak-surface-muted)",
        },
        muted: "var(--ak-muted)",
        line: "var(--ak-border)",
        bg: "var(--ak-bg)",
        success: "var(--ak-success)",
        warning: "var(--ak-warning)",
        error: "var(--ak-error)",
        brand: {
          DEFAULT: "var(--ak-brand)",
          strong: "var(--ak-brand-strong)",
          soft: "var(--ak-brand-soft)",
        },
        accent: "var(--ak-accent)",
        sidebar: {
          DEFAULT: "var(--ak-sidebar)",
          active: "var(--ak-sidebar-active)",
        },
      },
      borderRadius: {
        ak: "var(--ak-radius)",
        "ak-control": "var(--ak-radius-control)",
        "ak-card": "var(--ak-radius-card)",
        "ak-nav": "var(--ak-radius-nav)",
      },
      boxShadow: {
        ak: "var(--ak-shadow)",
        "ak-ring": "var(--ak-ring)",
      },
      maxWidth: {
        "ak-container": "var(--ak-container)",
      },
      fontFamily: {
        ak: "var(--ak-font)",
        "ak-mono": "var(--ak-font-mono)",
      },
      transitionProperty: {
        ak: "border-color, background-color, color, box-shadow, transform",
      },
    },
  },
} as const;

export default preset;
