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
  title: "AgentKitProject Account",
  tagline: "Shared identity for the AgentKitProject ecosystem.",
  accent: "#2f8f89", // Profile teal
  faviconSource: join(publicDir, "icon.svg"),
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
  const pngBySize = {};
  for (const [name, size] of favicons) {
    const buf = await sharp(iconSvg).resize(size, size).png().toBuffer();
    pngBySize[size] = buf;
    await writeFile(join(publicDir, name), buf);
  }
  console.log("Rendered favicon set (16/32/180).");

  // favicon.ico — browsers request this first; sharp can't emit .ico, so wrap
  // the 16+32 PNGs in a multi-size ICO (PNG-in-ICO is valid in all browsers).
  await writeFile(join(publicDir, "favicon.ico"), buildIco([pngBySize[16], pngBySize[32]]));
  console.log("Rendered favicon.ico (16+32).");
}

/** Build a multi-size ICO container from PNG buffers (PNG-encoded entries). */
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(pngs.length, 4);
  const entrySize = 16;
  let offset = 6 + entrySize * pngs.length;
  const entries = [];
  for (const png of pngs) {
    // Size byte: derive from the PNG IHDR width (bytes 16-19); 256 -> 0.
    const dim = png.readUInt32BE(16);
    const e = Buffer.alloc(entrySize);
    e.writeUInt8(dim >= 256 ? 0 : dim, 0); // width
    e.writeUInt8(dim >= 256 ? 0 : dim, 1); // height
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(png.length, 8); // byte size
    e.writeUInt32LE(offset, 12); // offset
    entries.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...pngs]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
