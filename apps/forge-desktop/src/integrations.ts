export type IntegrationId = "agentkitproject" | "agentkitmarket" | "agentkitauto";
export type IntegrationStatus = "disabled" | "disconnected" | "connected" | "error" | "comingSoon";
export type AccountConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
export type ExternalServiceType = "market" | "auto";
export type ExternalServiceKind = "agentkitproject_hosted" | "self_hosted" | "local";
export type ExternalServiceAuthMode = "none" | "agentkitproject" | "oidc" | "saml" | "api_token" | "custom";

export type ExternalServiceCapabilities = {
  browse?: boolean;
  download?: boolean;
  submit?: boolean;
  import?: boolean;
  runAutomation?: boolean;
  privateCatalog?: boolean;
};

export type ExternalServiceConnection = {
  id: string;
  name: string;
  serviceType: ExternalServiceType;
  baseUrl: string;
  kind: ExternalServiceKind;
  authMode: ExternalServiceAuthMode;
  status: IntegrationStatus;
  lastConnectedAt?: string;
  displayUser?: string;
  capabilities: ExternalServiceCapabilities;
};

export type AccountConnection = {
  accountConnectionStatus: AccountConnectionStatus;
  userDisplayName?: string;
  userEmail?: string;
  userHandle?: string;
  userId?: string;
  avatarInitials?: string;
  connectionError?: string;
  lastConnectedAt?: string;
};

export const agentKitProjectUrls = {
  forge: "https://forge.agentkitproject.com",
  profileAccount: "https://profile.agentkitproject.com/account",
  market: "https://market.agentkitproject.com",
  marketKits: "https://market.agentkitproject.com/kits",
  auto: "https://auto.agentkitproject.com",
} as const;

export const hostedMarketConnection: ExternalServiceConnection = {
  id: "agentkitproject-market",
  name: "AgentKitMarket",
  serviceType: "market",
  baseUrl: agentKitProjectUrls.market,
  kind: "agentkitproject_hosted",
  authMode: "agentkitproject",
  status: "disconnected",
  capabilities: {
    browse: true,
    download: true,
    submit: true,
    import: false,
    privateCatalog: false,
  },
};

export const privateMarketPlaceholderConnection: ExternalServiceConnection = {
  id: "private-market-placeholder",
  name: "Private Market",
  serviceType: "market",
  baseUrl: "",
  kind: "self_hosted",
  authMode: "custom",
  status: "comingSoon",
  capabilities: {
    browse: false,
    download: false,
    submit: false,
    import: false,
    privateCatalog: true,
  },
};

export const hostedAutoConnection: ExternalServiceConnection = {
  id: "agentkitproject-auto",
  name: "AgentKitAuto",
  serviceType: "auto",
  baseUrl: agentKitProjectUrls.auto,
  kind: "agentkitproject_hosted",
  authMode: "agentkitproject",
  status: "comingSoon",
  capabilities: {
    runAutomation: false,
  },
};

export const privateAutoPlaceholderConnection: ExternalServiceConnection = {
  id: "private-auto-placeholder",
  name: "Private Auto",
  serviceType: "auto",
  baseUrl: "",
  kind: "self_hosted",
  authMode: "custom",
  status: "comingSoon",
  capabilities: {
    runAutomation: false,
  },
};

export const defaultExternalServiceConnections = [
  hostedMarketConnection,
  privateMarketPlaceholderConnection,
  hostedAutoConnection,
  privateAutoPlaceholderConnection,
] as const;

export function disconnectedAccountConnection(): AccountConnection {
  return {
    accountConnectionStatus: "disconnected",
  };
}

export function integrationStatus(
  integrationId: IntegrationId,
  accountConnection: AccountConnection,
): IntegrationStatus {
  if (integrationId === "agentkitproject") {
    if (accountConnection.accountConnectionStatus === "connected") {
      return "connected";
    }
    if (accountConnection.accountConnectionStatus === "error") {
      return "error";
    }
    return "disconnected";
  }

  return "comingSoon";
}

export function canUseLocalForgeFeatures() {
  return true;
}

export function canUseManualPackageImport() {
  return true;
}

export function canUseManualMarketImport() {
  return canUseManualPackageImport();
}

export function canUseHostedMarketBrowse(connection: ExternalServiceConnection) {
  return connection.serviceType === "market" && connection.kind === "agentkitproject_hosted" && connection.capabilities.browse === true && connection.status !== "disabled";
}

export function canUseMarketSubmit(connection: ExternalServiceConnection) {
  return connection.serviceType === "market" && connection.status === "connected" && connection.capabilities.submit === true;
}

export function canUseMarketImport(connection: ExternalServiceConnection) {
  return canUseDirectMarketImport(connection);
}

export function canUseDirectMarketImport(connection: ExternalServiceConnection) {
  return connection.serviceType === "market" && connection.status === "connected" && connection.capabilities.import === true;
}

export function canUseAuto(connection: ExternalServiceConnection) {
  return connection.serviceType === "auto" && connection.status === "connected" && connection.capabilities.runAutomation === true;
}
