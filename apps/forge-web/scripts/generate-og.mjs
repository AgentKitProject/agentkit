#!/usr/bin/env node
/**
 * Generate this app's OG card + favicon set from the shared SVG template.
 *
 * Usage:  node scripts/generate-og.mjs   (run from the app root)
 *
 * Requires `sharp` for rasterization. If sharp is NOT installed, the script
 * still writes the OG SVG source and prints the one manual step.
 *
 * Outputs (relative to the app root):
 *   public/og.svg                     (always)
 *   public/og.png            1200x630 (when sharp present)
 *   public/favicon-16.png, -32.png, apple-touch-icon.png (when sharp present)
 *
 * Mirrors apps/site/scripts/generate-og.mjs.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname, "..");
const publicDir = join(appRoot, "public");
const templatePath = join(__dirname, "og-card.template.svg");

// Per-app card + favicon source.
const config = {
  title: "Web Forge",
  tagline: "Build and run portable Agent Kits in your browser.",
  accent: "#4f46e5", // Forge indigo
  faviconSource: join(publicDir, "brand", "agentkitforge-icon.svg"),
};

function fill(template, { title, tagline, accent }) {
  return template
    .replace(/\{\{TITLE\}\}/g, title)
    .replace(/\{\{TAGLINE\}\}/g, tagline)
    .replace(/\{\{ACCENT\}\}/g, accent)
    .replace(/\{\{TITLESIZE\}\}/g, title.length > 16 ? 58 : 86);
}

async function loadSharp() {
  try {
    return (await import("sharp")).default;
  } catch {
    return null;
  }
}

async function main() {
  const template = await readFile(templatePath, "utf8");
  const svg = fill(template, config);
  await writeFile(join(publicDir, "og.svg"), svg, "utf8");
  console.log("Wrote public/og.svg");

  const sharp = await loadSharp();
  if (!sharp) {
    console.log("\n[skip] sharp is not installed — PNG rasterization skipped.");
    console.log("To generate the PNGs, run from the repo root:");
    console.log("  pnpm --filter <this-app> add -D sharp");
    console.log("  node scripts/generate-og.mjs");
    return;
  }

  const ogPng = await sharp(Buffer.from(svg)).png().toBuffer();
  await writeFile(join(publicDir, "og.png"), ogPng);
  console.log("Rendered public/og.png (1200x630).");

  const iconSvg = await readFile(config.faviconSource);
  const favicons = [
    ["favicon-16.png", 16],
    ["favicon-32.png", 32],
    ["apple-touch-icon.png", 180],
  ];
  for (const [name, size] of favicons) {
    const buf = await sharp(iconSvg).resize(size, size).png().toBuffer();
    await writeFile(join(publicDir, name), buf);
  }
  console.log("Rendered favicon set (16/32/180).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
