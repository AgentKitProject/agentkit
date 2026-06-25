export type ProductStatus = "available" | "coming-later";

export type AgentKitProduct = {
  name: string;
  href: string;
  status: ProductStatus;
  description: string;
};

export const products: AgentKitProduct[] = [
  {
    name: "AgentKitMarket",
    href: "https://market.agentkitproject.com",
    status: "available",
    description: "Discover and use AgentKit packages. Market workflows stay in AgentKitMarket.",
  },
  {
    name: "AgentKitForge",
    href: "https://forge.agentkitproject.com",
    status: "coming-later",
    description: "Forge will integrate AgentKitProject login after Market Phase 1.",
  },
  {
    name: "AgentKitAuto",
    href: "https://auto.agentkitproject.com",
    status: "coming-later",
    description: "Auto access will connect to AgentKitProject auth in a later phase.",
  },
];
