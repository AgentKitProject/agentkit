import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://agentkitproject.com',
  integrations: [sitemap()],
  // The Roadmap page was removed; redirect any inbound /roadmap links to home
  // (external/bookmarked links + other apps' nav until they redeploy).
  redirects: {
    '/roadmap': '/'
  }
});
