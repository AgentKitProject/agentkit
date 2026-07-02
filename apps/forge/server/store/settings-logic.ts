// Pure mutation logic for UserSettings, shared by all adapters.
//
// Each adapter is responsible ONLY for loading a UserSettings object for a user
// and persisting it back; the add/remove/default/resolve semantics (including
// encrypt-on-write, keep-existing-key-on-update, never-return-secrets) live
// here so every backend behaves identically.
import crypto from "node:crypto";
import { decryptSecret, encryptSecret } from "@/server/store/shared";
import { assertProviderAllowed } from "@/server/store/provider-lock";
import {
  type PublicProvider,
  type SaveProviderInput,
  type StoredProvider,
  type UserSettings,
  toPublicProvider
} from "@/server/store/settings-types";

export function applySaveProvider(s: UserSettings, input: SaveProviderInput): { settings: UserSettings; record: StoredProvider } {
  assertProviderAllowed(input.providerType);
  const now = new Date().toISOString();
  const id = input.id?.trim() || crypto.randomUUID();
  const existing = s.providers.find((p) => p.id === id);
  const apiKey =
    input.apiKey && input.apiKey.trim() ? encryptSecret(input.apiKey.trim()) : existing?.apiKey;
  const record: StoredProvider = {
    id,
    name: input.name.trim() || input.providerType,
    providerType: input.providerType,
    baseUrl: input.baseUrl?.trim() || undefined,
    defaultModel: input.defaultModel?.trim() || undefined,
    supportsStructuredJson: input.supportsStructuredJson,
    apiKey,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  const providers = [...s.providers.filter((p) => p.id !== id), record];
  const defaultProviderId = s.defaultProviderId ?? id;
  return { settings: { ...s, providers, defaultProviderId }, record };
}

export function applyRemoveProvider(s: UserSettings, providerId: string): UserSettings {
  const providers = s.providers.filter((p) => p.id !== providerId);
  const defaultProviderId = s.defaultProviderId === providerId ? providers[0]?.id : s.defaultProviderId;
  return { ...s, providers, defaultProviderId };
}

export function applySetPreferences(s: UserSettings, preferences: Record<string, unknown>): UserSettings {
  return { ...s, preferences: { ...(s.preferences ?? {}), ...preferences } };
}

export function applySetDefault(s: UserSettings, providerId: string): UserSettings {
  if (!s.providers.some((p) => p.id === providerId)) throw new Error("Unknown provider id.");
  return { ...s, defaultProviderId: providerId };
}

export function resolveFromSettings(
  s: UserSettings,
  providerId?: string
): (StoredProvider & { apiKey?: string }) | null {
  const chosen =
    (providerId && s.providers.find((p) => p.id === providerId)) ||
    (s.defaultProviderId && s.providers.find((p) => p.id === s.defaultProviderId)) ||
    s.providers[0];
  if (!chosen) return null;
  return { ...chosen, apiKey: chosen.apiKey ? decryptSecret(chosen.apiKey) : undefined };
}

export function toPublic(s: UserSettings): {
  providers: PublicProvider[];
  defaultProviderId?: string;
  preferences?: Record<string, unknown>;
} {
  return { providers: s.providers.map(toPublicProvider), defaultProviderId: s.defaultProviderId, preferences: s.preferences };
}
