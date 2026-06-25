// Shared types and utilities for all ForgeApp section components.
import { getForgeClient } from "@/forge-client";
import type { MyKitEntry, ValidationReport } from "@/forge-client";

export type Forge = ReturnType<typeof getForgeClient>;
export type Notify = (msg: string, err?: boolean) => void;
export type UsageInfo = { kitCount: number; kitLimit: number; bytes: number; byteLimit: number } | null;

export type Favorite = {
  marketSlug: string;
  displayName?: string;
  publisher?: string;
  marketBaseUrl?: string;
  version?: string;
};

export type SessionUser = { id: string; email?: string } | null;

export type { PublicConfig, EcosystemLinks } from "@/lib/self-host";

export type PublicProvider = {
  id: string;
  name: string;
  providerType: string;
  baseUrl?: string;
  defaultModel?: string;
  supportsStructuredJson?: boolean;
  hasApiKey: boolean;
};

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

export function fmtBytes(b: number): string {
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export type { MyKitEntry, ValidationReport };
