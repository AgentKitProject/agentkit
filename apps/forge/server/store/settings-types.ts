// Shared UserSettings shapes + public-view helper, used by every
// UserSettingsStore adapter (local-disk, AWS DynamoDB, self-host Postgres).
// Persistence differs per adapter; these types and the secret-stripping rule do
// not.

export type StoredProvider = {
  id: string;
  name: string;
  providerType: "openai" | "anthropic" | "gemini" | "ollama" | "openai-compatible";
  baseUrl?: string;
  defaultModel?: string;
  supportsStructuredJson?: boolean;
  /** Encrypted-or-plaintext API key. NEVER returned to the client. */
  apiKey?: string;
  createdAt: string;
  updatedAt: string;
};

export type UserSettings = {
  providers: StoredProvider[];
  defaultProviderId?: string;
  preferences?: Record<string, unknown>;
};

/** Public provider view — secrets stripped, replaced by `hasApiKey`. */
export type PublicProvider = Omit<StoredProvider, "apiKey"> & { hasApiKey: boolean };

export type SaveProviderInput = {
  id?: string;
  name: string;
  providerType: StoredProvider["providerType"];
  baseUrl?: string;
  defaultModel?: string;
  supportsStructuredJson?: boolean;
  apiKey?: string;
};

export const EMPTY_SETTINGS: UserSettings = { providers: [] };

export function toPublicProvider(p: StoredProvider): PublicProvider {
  const { apiKey, ...rest } = p;
  return { ...rest, hasApiKey: Boolean(apiKey) };
}

/** The store contract that all settings adapters implement. */
export interface UserSettingsStore {
  getPublic(
    userId: string
  ): Promise<{ providers: PublicProvider[]; defaultProviderId?: string; preferences?: Record<string, unknown> }>;
  saveProvider(userId: string, input: SaveProviderInput): Promise<PublicProvider>;
  removeProvider(userId: string, providerId: string): Promise<void>;
  setPreferences(userId: string, preferences: Record<string, unknown>): Promise<void>;
  setDefault(userId: string, providerId: string): Promise<void>;
  resolveProvider(
    userId: string,
    providerId?: string
  ): Promise<(StoredProvider & { apiKey?: string }) | null>;
}
