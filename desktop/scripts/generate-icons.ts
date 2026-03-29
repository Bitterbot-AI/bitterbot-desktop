/**
 * Generate app icons from the Bitterbot avatar PNG.
 * electron-builder auto-converts a 256x256+ PNG to .ico/.icns per platform.
 *
 * Run: npx tsx scripts/generate-icons.ts
 */

import sharp from "sharp";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(__dirname, "../dist-renderer/bitterbot_avatar.png");
const out = path.resolve(__dirname, "../resources");
fs.mkdirSync(out, { recursive: true });

if (!fs.existsSync(src)) {
  console.error("Source PNG not found:", src);
  console.error("Build the renderer first: npx vite build");
  process.exit(1);
}

await sharp(src).resize(256, 256).toFile(path.join(out, "icon.png"));
console.log("Icons generated in desktop/resources/");
