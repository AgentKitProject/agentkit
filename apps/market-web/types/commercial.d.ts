/**
 * Ambient declaration for the OPTIONAL commercial package
 * `@agentkit-commercial/market-web` so the PUBLIC build typechecks WITHOUT it
 * installed. Intentionally loose (`any`) — the public app only ever reaches the
 * commercial exports through a dynamic import guarded by try/catch
 * (`lib/commercial.ts`) or `next/dynamic` gated on NEXT_PUBLIC_COMMERCE_ENABLED.
 * When the package IS installed (hosted build), its real types take precedence.
 */
declare module "@agentkit-commercial/market-web" {
  // Route handlers, UI components, and the purchases page are all exposed; the
  // public app never depends on their concrete shapes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const commercial: any;
  export = commercial;
}
