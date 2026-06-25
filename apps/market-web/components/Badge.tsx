import type { TrustBadge as TrustBadgeType } from "@/lib/market-api";
import type { ReactNode } from "react";

const trustClass: Record<string, string> = {
  Validated: "badge badge-teal",
  Reviewed: "badge badge-blue",
  "Verified Publisher": "badge badge-navy",
  Featured: "badge badge-featured"
};

export function Badge({ children, tone }: { children: ReactNode; tone?: "muted" | "teal" }) {
  return <span className={`badge ${tone === "teal" ? "badge-teal" : "badge-muted"}`}>{children}</span>;
}

export function TrustBadge({ status }: { status: TrustBadgeType }) {
  return <span className={trustClass[status] ?? "badge badge-muted"}>{status}</span>;
}
