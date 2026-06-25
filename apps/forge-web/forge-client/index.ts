// Public entry point for the web Forge transport.
//
// The desktop factory env-detects the Tauri webview and returns a
// TauriForgeClient. On the web there is only one implementation: WebForgeClient.
"use client";

import { WebForgeClient } from "./web-client";
import type { ForgeClient } from "./types";

export type { ForgeClient } from "./types";
export * from "./types";
export { WebForgeClient, NotAvailableOnWebError, HttpError, consumeSse } from "./web-client";
export type { GatewayStreamEvent, GatewayUsage } from "./web-client";

export function createForgeClient(): ForgeClient {
  return new WebForgeClient();
}

let sharedClient: ForgeClient | null = null;

export function getForgeClient(): ForgeClient {
  if (!sharedClient) {
    sharedClient = createForgeClient();
  }
  return sharedClient;
}
