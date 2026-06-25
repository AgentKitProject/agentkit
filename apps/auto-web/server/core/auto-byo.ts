// BYO (bring-your-own-key) management for AgentKitAuto — the user-facing half.
//
// A user can supply their OWN Anthropic API key so their Auto runs use that key
// (inferenceMode "byo", no managed-credit debit) instead of the platform key
// (inferenceMode "managed", debited at AUTO_MARKUP_BPS). They can also choose,
// per account, whether to PREFER byo or managed (a simple selector) — and the
// run-create path can override that per run.
//
// STORAGE: the key is a SECRET. It is stored via the EXISTING UserSettingsStore,
// which encrypts provider apiKeys at rest with AES-256-GCM (AGENTKITFORGE_WEB_SECRET)
// and NEVER returns the plaintext key from its public surface (only `hasApiKey`).
// We never log the key. The inference-mode preference is a non-secret stored in
// the same settings record's `preferences`.
//
// AUTH: this module is auth-agnostic (like server/core/auto.ts). The cookie route
// resolves the userId and calls these functions; the userId scopes all access.

import { getUserSettingsStore } from "@/server/store/user-settings";

/** The per-account inference-mode preference. "auto" = use byo when a key is
 *  configured, else managed (the historical behavior). "managed" forces the
 *  platform credit path even when a key exists; "byo" requires a key. */
export type InferenceModePreference = "auto" | "managed" | "byo";

const PREF_KEY = "autoInferenceMode";
/** The provider id we manage for the Auto BYO key (single, well-known id so the
 *  key flow is idempotent and doesn't proliferate provider records). */
const BYO_PROVIDER_ID = "auto-byo-anthropic";

export class ByoKeyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ByoKeyValidationError";
  }
}

/**
 * Validates the SHAPE of an Anthropic API key without contacting Anthropic.
 * Anthropic keys are `sk-ant-...` tokens; we require the prefix and a sane
 * length. We deliberately do NOT make a network call here (no real inference);
 * a wrong-but-well-formed key surfaces at run time as a provider error.
 *
 * NEVER include the key (or any substring) in the thrown message.
 */
export function validateAnthropicKeyFormat(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw new ByoKeyValidationError("An API key is required.");
  }
  if (!trimmed.startsWith("sk-ant-")) {
    throw new ByoKeyValidationError('Anthropic API keys start with "sk-ant-".');
  }
  if (trimmed.length < 20 || trimmed.length > 300) {
    throw new ByoKeyValidationError("That does not look like a valid Anthropic API key.");
  }
  if (/\s/.test(trimmed)) {
    throw new ByoKeyValidationError("An API key must not contain whitespace.");
  }
  return trimmed;
}

/** The public (secret-free) BYO status for the settings UI. */
export interface ByoKeyStatus {
  hasKey: boolean;
  /** The user's inference-mode preference (defaults to "auto"). */
  inferenceMode: InferenceModePreference;
}

function readPreference(prefs: Record<string, unknown> | undefined): InferenceModePreference {
  const raw = prefs?.[PREF_KEY];
  return raw === "managed" || raw === "byo" || raw === "auto" ? raw : "auto";
}

/** Returns the secret-free BYO status (hasKey + the mode preference). */
export async function getByoKeyStatus(userId: string): Promise<ByoKeyStatus> {
  const store = await getUserSettingsStore();
  const pub = await store.getPublic(userId);
  const provider = pub.providers.find((p) => p.id === BYO_PROVIDER_ID);
  return {
    hasKey: Boolean(provider?.hasApiKey),
    inferenceMode: readPreference(pub.preferences),
  };
}

/**
 * Sets/updates the BYO Anthropic key (encrypted at rest by the store) and/or the
 * inference-mode preference. Validates the key format; never logs it. Passing no
 * key updates only the preference (leaving any existing key intact).
 */
export async function setByoKey(
  userId: string,
  input: { apiKey?: string; inferenceMode?: InferenceModePreference },
): Promise<ByoKeyStatus> {
  const store = await getUserSettingsStore();

  if (input.apiKey !== undefined) {
    const validated = validateAnthropicKeyFormat(input.apiKey);
    // saveProvider encrypts apiKey at rest and never echoes it back.
    await store.saveProvider(userId, {
      id: BYO_PROVIDER_ID,
      name: "Anthropic (your key)",
      providerType: "anthropic",
      apiKey: validated,
    });
  }

  if (input.inferenceMode !== undefined) {
    await store.setPreferences(userId, { [PREF_KEY]: input.inferenceMode });
  }

  return getByoKeyStatus(userId);
}

/** Clears the BYO key (the user reverts to managed credits). Idempotent. */
export async function clearByoKey(userId: string): Promise<ByoKeyStatus> {
  const store = await getUserSettingsStore();
  await store.removeProvider(userId, BYO_PROVIDER_ID);
  return getByoKeyStatus(userId);
}

/** Resolve the BYO provider id the billing path should use (so auto.ts resolves
 *  the SAME well-known provider record this module writes). */
export function byoProviderId(): string {
  return BYO_PROVIDER_ID;
}

/** Resolve the user's inference-mode preference (defaults to "auto"). */
export async function getInferenceModePreference(userId: string): Promise<InferenceModePreference> {
  const store = await getUserSettingsStore();
  const pub = await store.getPublic(userId);
  return readPreference(pub.preferences);
}
