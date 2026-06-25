import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: ["/", "/u/"], disallow: ["/api/", "/auth/", "/account/"] },
    sitemap: "https://profile.agentkitproject.com/sitemap.xml",
  };
}
