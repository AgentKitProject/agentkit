// Self-host PROVIDER-LOCK enforcement for the settings store.
//
// An operator may restrict which AI provider types users can configure via the
// ALLOWED_PROVIDERS env (see lib/self-host.getAllowedProviders). Every
// UserSettingsStore adapter routes provider creation/update through here so the
// policy is enforced uniformly, regardless of backend (disk / aws / selfhost).
import { getAllowedProviders, isProviderAllowed } from "@/lib/self-host";

/**
 * Throw a clear error if `providerType` is not permitted by the provider-lock
 * policy. No-op when unrestricted (ALLOWED_PROVIDERS unset/empty).
 */
export function assertProviderAllowed(providerType: string): void {
  if (isProviderAllowed(providerType)) return;
  const allowed = getAllowedProviders() ?? [];
  throw new Error(
    `Provider type "${providerType}" is not allowed on this instance. Allowed providers: ${allowed.join(", ") || "(none)"}.`
  );
}
