// Optional React context for the Forge client, so components can obtain the
// client via a hook instead of importing the module singleton directly. Both
// access styles resolve to the same instance.

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { getForgeClient } from "./index";
import type { ForgeClient } from "./types";

const ForgeClientContext = createContext<ForgeClient | null>(null);

export function ForgeClientProvider({
  client,
  children,
}: {
  client?: ForgeClient;
  children: ReactNode;
}) {
  const value = useMemo(() => client ?? getForgeClient(), [client]);
  return <ForgeClientContext.Provider value={value}>{children}</ForgeClientContext.Provider>;
}

export function useForgeClient(): ForgeClient {
  const client = useContext(ForgeClientContext);
  // Fall back to the singleton so the hook works even without a provider,
  // keeping migration low-risk.
  return client ?? getForgeClient();
}
