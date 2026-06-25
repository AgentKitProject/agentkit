import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: "https://profile.agentkitproject.com", lastModified: new Date(), changeFrequency: "monthly", priority: 1 },
    { url: "https://profile.agentkitproject.com/privacy", lastModified: new Date(), changeFrequency: "yearly", priority: 0.3 },
    { url: "https://profile.agentkitproject.com/terms", lastModified: new Date(), changeFrequency: "yearly", priority: 0.3 },
    { url: "https://profile.agentkitproject.com/security", lastModified: new Date(), changeFrequency: "yearly", priority: 0.3 },
    { url: "https://profile.agentkitproject.com/legal/kit-license", lastModified: new Date(), changeFrequency: "yearly", priority: 0.3 },
  ];
}
