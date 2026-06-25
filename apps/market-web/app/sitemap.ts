import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: "https://market.agentkitproject.com", lastModified: new Date(), changeFrequency: "daily", priority: 1 },
    { url: "https://market.agentkitproject.com/kits", lastModified: new Date(), changeFrequency: "daily", priority: 0.9 },
    { url: "https://market.agentkitproject.com/submit", lastModified: new Date(), changeFrequency: "monthly", priority: 0.7 },
    { url: "https://market.agentkitproject.com/pricing", lastModified: new Date(), changeFrequency: "monthly", priority: 0.6 },
    { url: "https://market.agentkitproject.com/privacy", lastModified: new Date(), changeFrequency: "yearly", priority: 0.3 },
    { url: "https://market.agentkitproject.com/terms", lastModified: new Date(), changeFrequency: "yearly", priority: 0.3 },
    { url: "https://market.agentkitproject.com/security", lastModified: new Date(), changeFrequency: "yearly", priority: 0.3 },
    { url: "https://market.agentkitproject.com/legal/kit-license", lastModified: new Date(), changeFrequency: "yearly", priority: 0.3 },
  ];
}
