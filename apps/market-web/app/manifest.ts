import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AgentKitMarket",
    short_name: "AKMarket",
    description: "Public discovery, review, and distribution for reusable Agent Kits.",
    start_url: "/",
    display: "standalone",
    background_color: "#f9ffff",
    theme_color: "#0b153b",
    icons: [
      { src: "/brand/agentkitmarket-icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
