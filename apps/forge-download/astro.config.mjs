import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://forge.agentkitproject.com',
  output: 'static',
  trailingSlash: 'always',
  integrations: [sitemap()]
});
