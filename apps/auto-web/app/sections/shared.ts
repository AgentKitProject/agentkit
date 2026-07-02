// Shared types + utilities for the Auto UI section.
//
// Ported from agentkitforge/app/forge/sections/shared.ts, trimmed to ONLY
// the symbols AgentKitAuto needs: `MyKitEntry` (the kit-selector option shape),
// `Notify` (the toast callback), and `errMsg`.
import type { MyKitEntry } from "@/forge-client";

export type Notify = (msg: string, err?: boolean) => void;

// Secret-free provider view returned by GET /api/auto/ai-providers — mirrors the
// forge-web PublicProvider shape (the API never returns the key, only hasApiKey).
export type PublicProvider = {
  id: string;
  name: string;
  providerType: string;
  baseUrl?: string;
  defaultModel?: string;
  supportsStructuredJson?: boolean;
  hasApiKey: boolean;
};

// Provider catalog entry (the 5 types + their capabilities + known models),
// served alongside the providers list to drive the add/update form.
export type CatalogEntry = {
  providerType: string;
  apiKeyRequired: boolean;
  baseUrlRequired: boolean;
  supportsCustomModels: boolean;
  supportsStructuredJson: boolean;
  defaultModel?: string;
  models: { id: string; label: string; recommendedFor: string[] }[];
};

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type { MyKitEntry };
