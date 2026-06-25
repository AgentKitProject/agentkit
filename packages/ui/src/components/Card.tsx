"use client";

import * as React from "react";

export type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  /** Optional title rendered in a card header. */
  title?: React.ReactNode;
  /** Optional fully custom header node (overrides `title` when provided). */
  header?: React.ReactNode;
  children?: React.ReactNode;
};

export const Card = React.forwardRef<HTMLDivElement, CardProps>(function Card(
  { title, header, className, children, ...rest },
  ref,
) {
  const headerNode =
    header ??
    (title ? <h3 className="ak-card__title">{title}</h3> : null);

  return (
    <div
      {...rest}
      ref={ref}
      className={["ak-card", className].filter(Boolean).join(" ")}
    >
      {headerNode ? <div className="ak-card__header">{headerNode}</div> : null}
      {children}
    </div>
  );
});
