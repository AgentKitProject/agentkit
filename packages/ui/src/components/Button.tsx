"use client";

import * as React from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

type CommonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  className?: string;
  children?: React.ReactNode;
};

type ButtonAsButton = CommonProps &
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps> & {
    href?: undefined;
  };

type ButtonAsAnchor = CommonProps &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps> & {
    href: string;
  };

export type ButtonProps = ButtonAsButton | ButtonAsAnchor;

function classes(
  variant: ButtonVariant,
  size: ButtonSize,
  loading: boolean,
  extra?: string,
): string {
  return [
    "ak-btn",
    `ak-btn--${variant}`,
    `ak-btn--${size}`,
    loading ? "ak-btn--loading" : "",
    extra ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Themeable button. Renders a native `<button>`, or an `<a>` when `href` is
 * provided (anchor-friendly for SSR + framework links).
 */
export const Button = React.forwardRef<
  HTMLButtonElement | HTMLAnchorElement,
  ButtonProps
>(function Button(props, ref) {
  const {
    variant = "primary",
    size = "md",
    loading = false,
    className,
    children,
    ...rest
  } = props;

  const cls = classes(variant, size, loading, className);
  const content = (
    <>
      {loading ? <span className="ak-btn__spinner" aria-hidden="true" /> : null}
      {children}
    </>
  );

  if ("href" in props && props.href !== undefined) {
    const { href, ...anchorRest } = rest as ButtonAsAnchor;
    return (
      <a
        {...anchorRest}
        href={href}
        ref={ref as React.Ref<HTMLAnchorElement>}
        className={cls}
        aria-disabled={loading || undefined}
      >
        {content}
      </a>
    );
  }

  const { disabled, ...btnRest } = rest as ButtonAsButton;
  return (
    <button
      {...btnRest}
      ref={ref as React.Ref<HTMLButtonElement>}
      className={cls}
      disabled={disabled || loading}
    >
      {content}
    </button>
  );
});
