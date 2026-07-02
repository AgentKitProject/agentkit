// Server-side loader for @agentkitforge/core. Node-only — must NEVER be
// imported from a client component. We use a dynamic import so the package
// (which touches node:fs, node:child_process, etc.) stays out of any client
// bundle and resolves at runtime in the server runtime.
//
// `import("@agentkitforge/core")` is typed via the package's own d.ts.
type CoreModule = typeof import("@agentkitforge/core");
type CoreMarketModule = typeof import("@agentkitforge/core/market");

let corePromise: Promise<CoreModule> | null = null;
let marketPromise: Promise<CoreMarketModule> | null = null;

export function loadCore(): Promise<CoreModule> {
  if (!corePromise) {
    corePromise = import("@agentkitforge/core");
  }
  return corePromise;
}

export function loadCoreMarket(): Promise<CoreMarketModule> {
  if (!marketPromise) {
    marketPromise = import("@agentkitforge/core/market");
  }
  return marketPromise;
}
