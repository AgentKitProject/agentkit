"use client";

import * as React from "react";

export type BadgeTone = "brand" | "success" | "warning" | "error" | "neutral";

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  children?: React.ReactNode;
};

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  function Badge({ tone = "brand", className, children, ...rest }, ref) {
    const toneClass = tone === "brand" ? "" : `ak-badge--${tone}`;
    return (
      <span
        {...rest}
        ref={ref}
        className={["ak-badge", toneClass, className]
          .filter(Boolean)
          .join(" ")}
      >
        {children}
      </span>
    );
  },
);

/** Alias — Pill is the same component (pill radius is built in). */
export const Pill = Badge;
export type PillProps = BadgeProps;
