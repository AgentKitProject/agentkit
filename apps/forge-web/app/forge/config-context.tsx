"use client";

// Client-side access to the server-resolved PublicConfig (self-host / Market /
// credits / ecosystem links). The config is resolved on the server in page.tsx
// (lib/self-host.getPublicConfig) and provided here so any section can read it
// without prop-drilling. Defaults to the HOSTED shape so a missing provider
// (e.g. in a unit test render) behaves like hosted, unchanged.
import { createContext, useContext, type ReactNode } from "react";
import type { PublicConfig } from "@/lib/self-host";

const HOSTED_DEFAULT: PublicConfig = {
  selfHost: false,
  marketEnabled: true,
  creditsEnabled: false,
  links: {
    projectUrl: "https://agentkitproject.com",
    marketUrl: "https://market.agentkitproject.com",
    forgeUrl: "https://forge.agentkitproject.com",
    profileUrl: "https://profile.agentkitproject.com",
    autoUrl: "https://auto.agentkitproject.com"
  }
};

const ConfigContext = createContext<PublicConfig>(HOSTED_DEFAULT);

export function ConfigProvider({ value, children }: { value: PublicConfig; children: ReactNode }) {
  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

/** Read the active PublicConfig from any client section. */
export function useConfig(): PublicConfig {
  return useContext(ConfigContext);
}
