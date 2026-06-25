// Public entry point for the typed Forge transport abstraction.
//
// `createForgeClient()` is the single place where the runtime decides which
// implementation backs the UI. Today it always returns the Tauri (desktop)
// client. A future web build will env-detect (e.g. `!('__TAURI_INTERNALS__' in
// window)`) and return a `FetchForgeClient` instead — the UI never changes.

import { TauriForgeClient } from "./tauri-client";
import type { ForgeClient } from "./types";

export type { ForgeClient } from "./types";
export * from "./types";

export function createForgeClient(): ForgeClient {
  // WEB: env-detect here and return a FetchForgeClient when running in a
  // plain browser context instead of the Tauri webview.
  return new TauriForgeClient();
}

// Module singleton — components that don't take the client via context can
// import this directly. There is exactly one client per app instance.
let sharedClient: ForgeClient | null = null;

export function getForgeClient(): ForgeClient {
  if (!sharedClient) {
    sharedClient = createForgeClient();
  }
  return sharedClient;
}
