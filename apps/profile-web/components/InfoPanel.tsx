import { Card } from "@agentkitforge/ui";

/**
 * Thin wrapper over the shared framework `Card` so existing account-page call
 * sites (`<InfoPanel>…</InfoPanel>`) keep working while rendering off the
 * shared design tokens (border / radius / surface / shadow).
 */
export function InfoPanel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <Card className={className}>{children}</Card>;
}
