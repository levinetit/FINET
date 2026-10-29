// Generează iconițele PWA (Faza 9, ADR 0020) din simbolul-grafic al logoului
// (`src/app/_components/logo.tsx`: linia + moneda), fără text: fontul wordmark-ului nu e
// disponibil în randarea SVG a lui sharp. Rulare: `node scripts/make-pwa-icons.mjs`
// (rezultatul, în `public/icons/`, se commit-uiește; scriptul e determinist).
//
// - `any`: pătrat cu colțuri rotunjite, simbolul pe ~70% din latură;
// - `maskable`: fundal pe toată suprafața, simbolul în zona sigură (cercul de 80%, deci
//   simbolul pe ≤ 56% din latură), ca decupajele Android (cerc, picătură) să nu-l taie;
// - `apple-touch-icon` (180 px): fundal plin, fără transparență (iOS pune negru în loc).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "icons");

// Culorile temei luminoase (`src/app/globals.css`): fundal accent, linia albă, moneda `marker`.
const BG = "#1f45b8";
const LINE = "#ffffff";
const COIN = "#f6dc6b";

// Simbolul din logo: viewBox „1 2 17 22” (17 × 22).
const MARK = `<path d="M1.5 18.5 H5 L7 22.5 L10 5 L12.6 17 L14.2 13.5 L16.5 3.5" stroke="${LINE}"
  stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <circle cx="16.5" cy="3.5" r="1.9" fill="${COIN}"/>`;

/** SVG-ul unei iconițe: `fill` = fracțiunea din latură ocupată de înălțimea simbolului. */
export function iconSvg(size, { fill, rounded }) {
  const markH = 22 + 4; // înălțimea viewBox-ului + marginea liniei (stroke 3.4, capete rotunde)
  const scale = (size * fill) / markH;
  const w = 17 * scale;
  const h = 22 * scale;
  const x = (size - w) / 2 - 1 * scale;
  const y = (size - h) / 2 - 2 * scale;
  const radius = rounded ? Math.round(size * 0.22) : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="${BG}"/>
  <g transform="translate(${x.toFixed(3)} ${y.toFixed(3)}) scale(${scale.toFixed(5)})">${MARK}</g>
</svg>`;
}

export const ICONS = [
  { file: "icon-192.png", size: 192, fill: 0.7, rounded: true },
  { file: "icon-512.png", size: 512, fill: 0.7, rounded: true },
  { file: "icon-maskable-192.png", size: 192, fill: 0.5, rounded: false },
  { file: "icon-maskable-512.png", size: 512, fill: 0.5, rounded: false },
  { file: "apple-touch-icon.png", size: 180, fill: 0.62, rounded: false },
];

async function main() {
  await mkdir(OUT, { recursive: true });
  for (const icon of ICONS) {
    const png = await sharp(Buffer.from(iconSvg(icon.size, icon)))
      .png({ compressionLevel: 9, palette: false })
      .toBuffer();
    await writeFile(join(OUT, icon.file), png);
    console.log(`${icon.file}: ${png.length} octeți`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
