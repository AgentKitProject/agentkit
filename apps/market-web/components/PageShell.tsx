import type { ReactNode } from "react";

export function PageShell({
  eyebrow,
  title,
  children,
  actions
}: {
  eyebrow?: string;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="page-shell">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
      <div className="page-body">{children}</div>
    </section>
  );
}
