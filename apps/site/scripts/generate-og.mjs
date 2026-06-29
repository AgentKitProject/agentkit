#!/usr/bin/env node
/**
 * Generate OG-card PNGs (and a lightweight favicon set) from the SVG template.
 *
 * Usage:
 *   node scripts/generate-og.mjs
 *
 * Requires `sharp` for rasterization. If sharp is NOT installed, the script
 * still writes the per-surface SVG sources to public/brand/og/ and prints the
 * one manual step (`pnpm add -D sharp && node scripts/generate-og.mjs`).
 *
 * Outputs (relative to apps/site/):
 *   public/brand/og/<surface>.svg            (always)
 *   public/brand/og/<surface>.png  1200x630  (when sharp present)
 *   public/brand/agentkitproject-og.png      (default card, overwrites)
 *   public/brand/favicon-16.png, -32.png, apple-touch-icon-180.png (when sharp present)
 *
 * The existing referenced assets already exist; this script lets you (re)generate
 * them and add per-surface cards. See DOCS_LAUNCH_POLISH_PLAN.md.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(__dirname, '..');
const templatePath = join(__dirname, 'og-card.template.svg');
const outDir = join(siteRoot, 'public', 'brand', 'og');
const brandDir = join(siteRoot, 'public', 'brand');

// Per-surface cards. `default` overwrites the site-wide agentkitproject-og.png.
const surfaces = [
  { key: 'default', title: 'AgentKitProject', tagline: 'Create, share, and automate Agent Kits.', accent: '#6d46e9' },
  { key: 'forge', title: 'AgentKitForge', tagline: 'Build and run portable Agent Kits.', accent: '#5b4cf0' },
  { key: 'market', title: 'AgentKitMarket', tagline: 'Discover, share, and sell Agent Kits.', accent: '#0fb3d1' },
  { key: 'auto', title: 'AgentKitAuto', tagline: 'Schedule and automate trusted kits.', accent: '#16a34a' }
];

function fill(template, { title, tagline, accent }) {
  return template
    .replace(/\{\{TITLE\}\}/g, title)
    .replace(/\{\{TAGLINE\}\}/g, tagline)
    .replace(/\{\{ACCENT\}\}/g, accent)
    .replace(/\{\{TITLESIZE\}\}/g, title.length > 16 ? 58 : 86);
}

async function loadSharp() {
  try {
    const mod = await import('sharp');
    return mod.default;
  } catch {
    return null;
  }
}

async function main() {
  const template = await readFile(templatePath, 'utf8');
  await mkdir(outDir, { recursive: true });

  // Always emit per-surface SVG sources.
  const svgs = {};
  for (const s of surfaces) {
    const svg = fill(template, s);
    svgs[s.key] = svg;
    await writeFile(join(outDir, `${s.key}.svg`), svg, 'utf8');
  }
  console.log(`Wrote ${surfaces.length} OG-card SVGs to public/brand/og/`);

  const sharp = await loadSharp();
  if (!sharp) {
    console.log('\n[skip] sharp is not installed — PNG rasterization skipped.');
    console.log('To generate the PNGs the <meta> tags reference, run:');
    console.log('  pnpm --filter @agentkitproject/site add -D sharp');
    console.log('  node apps/site/scripts/generate-og.mjs');
    return;
  }

  // Rasterize OG cards (1200x630).
  for (const s of surfaces) {
    const png = await sharp(Buffer.from(svgs[s.key])).png().toBuffer();
    await writeFile(join(outDir, `${s.key}.png`), png);
    if (s.key === 'default') {
      await writeFile(join(brandDir, 'agentkitproject-og.png'), png);
    }
  }
  console.log('Rendered OG-card PNGs (1200x630).');

  // Lightweight favicon set from the project icon SVG.
  const iconSvgPath = join(brandDir, 'agentkitproject-icon.svg');
  const iconSvg = await readFile(iconSvgPath);
  const faviconSizes = [
    ['favicon-16.png', 16],
    ['favicon-32.png', 32],
    ['apple-touch-icon-180.png', 180]
  ];
  for (const [name, size] of faviconSizes) {
    const buf = await sharp(iconSvg).resize(size, size).png().toBuffer();
    await writeFile(join(brandDir, name), buf);
  }
  console.log('Rendered favicon set (16/32/180).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
