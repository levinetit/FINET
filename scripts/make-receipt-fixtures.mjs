#!/usr/bin/env node
// Bonuri fiscale SINTETICE pentru evaluarea pipeline-ului (Faza 6, F6-B; ADR 0014).
//
//   node scripts/make-receipt-fixtures.mjs [director]   # implicit fixtures/receipts/generated
//
// Fiecare bon e descris aici (adevărul, „ground truth”), apoi desenat în cod: SVG → PNG/JPEG cu
// sharp (cu variații: rotire, zgomot, „mototolit” simulat prin forfecare + estompare + contrast,
// bon lung în 3 părți cu suprapunere) sau PDF cu text scris de mână. Nimic binar în repo:
// fișierele generate stau în `fixtures/receipts/generated/` (ignorat de git), iar adevărul în
// `fixtures/receipts/ground-truth.json` (scris tot de acest script, determinist).
//
// ATENȚIE: acuratețea măsurată pe aceste bonuri SINTETICE nu înlocuiește evaluarea pe bonuri
// reale (de făcut de operator). Comercianții și CUI-urile sunt publice; numerele de bon, produsele
// și sumele sunt inventate.
//
// Textul din SVG cere fonturi de sistem (fontconfig + de exemplu DejaVu); fără ele, imaginile nu
// au text (scriptul avertizează) și doar modul „mock” al evaluării are sens.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";

/** Cota TVA inclusă (puncte de bază), rotunjită la jumătate în sus, fără float. */
function vatOf(totalMinor, bp) {
  const n = BigInt(totalMinor) * BigInt(bp);
  const d = 10000n + BigInt(bp);
  return (n * 2n + d) / (2n * d);
}

const L = (name, quantity, unitPrice, lineTotal, vatRate, type, category) => ({
  name,
  quantity,
  unitPrice,
  lineTotal,
  vatRate,
  type,
  category,
});

/** Bonurile: sume ca șiruri `"12.50"` (aceeași formă ca ieșirea cerută modelului). */
const SPECS = [
  {
    id: "lidl-simplu",
    variant: { format: "jpeg" },
    merchantName: "LIDL DISCOUNT SRL",
    merchantTaxId: "RO22891860",
    storeAddress: "Str. Exemplu 10, Cluj-Napoca",
    receiptNumber: "0142",
    date: "2026-10-12",
    paymentMethod: "card",
    lines: [
      L("LAPTE ZUZU 1,5% 1L", "2", "7.49", "14.98", "11", "item", "Alimente"),
      L("PAINE FELIATA 500G", "1", "5.99", "5.99", "11", "item", "Alimente"),
      L("SAMPON HAIR 400ML", "1", "18.90", "18.90", "21", "item", "Igienă și cosmetice"),
      L("GARANTIE SGR", "2", "0.50", "1.00", "0", "deposit", null),
    ],
  },
  {
    id: "kaufland-reducere-punga",
    variant: { format: "png" },
    merchantName: "KAUFLAND ROMANIA SCS",
    merchantTaxId: "RO15991149",
    storeAddress: "Bd. Exemplu 2, București",
    receiptNumber: "5531",
    date: "2026-10-18",
    paymentMethod: "cash",
    lines: [
      L("CAFEA MACINATA 500G", "1", "32.99", "32.99", "11", "item", "Alimente"),
      L("REDUCERE CARD", null, null, "5.00", "11", "discount", null),
      L("DETERGENT VASE 1L", "1", "12.49", "12.49", "21", "item", "Casă și reparații"),
      L("PUNGA RAFIE", "1", "0.50", "0.50", "21", "bag", null),
    ],
  },
  {
    id: "rotit-7-grade",
    variant: { format: "jpeg", rotate: 7 },
    merchantName: "DEDEMAN SRL",
    merchantTaxId: "RO2816464",
    storeAddress: "Str. Exemplu 5, Bacău",
    receiptNumber: "77120",
    date: "2026-09-30",
    paymentMethod: "card",
    lines: [
      L("SURUBELNITA SET 6 BUC", "1", "49.90", "49.90", "21", "item", "Casă și reparații"),
      L("BEC LED E27 9W", "3", "8.99", "26.97", "21", "item", "Casă și reparații"),
    ],
  },
  {
    id: "zgomot-estompat",
    variant: { format: "jpeg", noise: true, blur: 1.2, quality: 55 },
    merchantName: "LIDL DISCOUNT SRL",
    merchantTaxId: "RO22891860",
    storeAddress: "Str. Exemplu 10, Cluj-Napoca",
    receiptNumber: "0177",
    date: "2026-10-21",
    paymentMethod: "card",
    lines: [
      L("BANANE", "1.254", "6.99", "8.77", "11", "item", "Alimente"),
      L("IAURT GRECESC 400G", "2", "6.49", "12.98", "11", "item", "Alimente"),
      L("APA PLATA 2L", "6", "2.29", "13.74", "11", "item", "Alimente"),
      L("GARANTIE SGR", "6", "0.50", "3.00", "0", "deposit", null),
    ],
  },
  {
    id: "mototolit",
    variant: { format: "jpeg", crumple: true },
    merchantName: "KAUFLAND ROMANIA SCS",
    merchantTaxId: "RO15991149",
    storeAddress: "Bd. Exemplu 2, București",
    receiptNumber: "5602",
    date: "2026-10-25",
    paymentMethod: "card",
    lines: [
      L("PASTA DINTI 75ML", "1", "11.99", "11.99", "21", "item", "Igienă și cosmetice"),
      L("ROSII CHERRY 250G", "2", "7.99", "15.98", "11", "item", "Alimente"),
    ],
  },
  {
    id: "pdf-text",
    variant: { format: "pdf" },
    merchantName: "LIDL DISCOUNT SRL",
    merchantTaxId: "RO22891860",
    storeAddress: "Str. Exemplu 10, Cluj-Napoca",
    receiptNumber: "0199",
    date: "2026-10-27",
    paymentMethod: "card",
    lines: [
      L("ULEI FLOAREA SOARELUI 1L", "1", "9.99", "9.99", "11", "item", "Alimente"),
      L("HARTIE IGIENICA 10 ROLE", "1", "19.99", "19.99", "21", "item", "Igienă și cosmetice"),
    ],
  },
  {
    id: "tva-vechi-19",
    variant: { format: "jpeg" },
    merchantName: "LIDL DISCOUNT SRL",
    merchantTaxId: "RO22891860",
    storeAddress: "Str. Exemplu 10, Cluj-Napoca",
    receiptNumber: "0031",
    date: "2025-06-14",
    paymentMethod: "cash",
    lines: [
      L("ZAHAR 1KG", "1", "4.99", "4.99", "9", "item", "Alimente"),
      L("SAPUN LICHID 500ML", "1", "8.49", "8.49", "19", "item", "Igienă și cosmetice"),
    ],
  },
  {
    id: "bon-lung-3-parti",
    variant: { format: "jpeg", parts: 3, overlap: 1 },
    merchantName: "KAUFLAND ROMANIA SCS",
    merchantTaxId: "RO15991149",
    storeAddress: "Bd. Exemplu 2, București",
    receiptNumber: "5777",
    date: "2026-10-28",
    paymentMethod: "card",
    lines: [
      L("LAPTE 3,5% 1L", "1", "8.49", "8.49", "11", "item", "Alimente"),
      L("OUA M 10 BUC", "1", "13.99", "13.99", "11", "item", "Alimente"),
      L("MERE GOLDEN 1KG", "1", "6.11", "6.11", "11", "item", "Alimente"),
      L("SAMPON 250ML", "1", "15.49", "15.49", "21", "item", "Igienă și cosmetice"),
      L("LAPTE 3,5% 1L", "1", "8.49", "8.49", "11", "item", "Alimente"),
      L("SERVETELE 100 BUC", "1", "4.99", "4.99", "21", "item", "Igienă și cosmetice"),
      L("GARANTIE SGR", "1", "0.50", "0.50", "0", "deposit", null),
    ],
  },
];

const toMinor = (s) => {
  const [i, f = ""] = s.split(".");
  return BigInt(i) * 100n + BigInt(f.padEnd(2, "0"));
};
const fromMinor = (m) => `${m / 100n}.${String(m % 100n).padStart(2, "0")}`;
const comma = (s) => s.replace(".", ",");

/** Adevărul complet: totalul și TVA-ul calculate în întregi din linii. */
function groundTruth(spec) {
  let total = 0n;
  let vat = 0n;
  for (const l of spec.lines) {
    const t = toMinor(l.lineTotal);
    const sign = l.type === "discount" ? -1n : 1n;
    total += sign * t;
    vat += sign * vatOf(t, Number(l.vatRate) * 100);
  }
  const { variant, ...rest } = spec;
  return { ...rest, variant, currency: "RON", total: fromMinor(total), vatTotal: fromMinor(vat) };
}

export const FIXTURES = SPECS.map(groundTruth);

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Rândurile de text ale bonului (antet, linii, total), ca pe o casă de marcat. */
function receiptRows(gt) {
  const head = [gt.merchantName, `CIF: ${gt.merchantTaxId}`, gt.storeAddress, "-".repeat(32)];
  const body = [];
  for (const l of gt.lines) {
    const letter = { 21: "A", 11: "B", 9: "B", 19: "A", 0: "D" }[Number(l.vatRate)] ?? "C";
    if (l.type === "discount") {
      body.push(`${l.name}`, `   -${comma(l.lineTotal)} ${letter}`);
    } else if (l.quantity && l.quantity !== "1") {
      body.push(
        `${l.quantity.replace(".", ",")} x ${comma(l.unitPrice)}`,
        `${l.name}   ${comma(l.lineTotal)} ${letter}`,
      );
    } else {
      body.push(`${l.name}   ${comma(l.lineTotal)} ${letter}`);
    }
  }
  const [y, m, d] = gt.date.split("-");
  const tail = [
    "-".repeat(32),
    `TOTAL  ${comma(gt.total)} LEI`,
    `TOTAL TVA  ${comma(gt.vatTotal)}`,
    gt.paymentMethod === "card" ? "CARD" : "NUMERAR",
    `${d}.${m}.${y} 12:34`,
    `BON FISCAL NR. ${gt.receiptNumber}`,
  ];
  return { head, body, tail };
}

function svgOf(rows, width = 576) {
  const lineH = 30;
  const height = rows.length * lineH + 60;
  const text = rows
    .map(
      (r, i) =>
        `<text x="24" y="${50 + i * lineH}" font-family="DejaVu Sans Mono, Liberation Mono, monospace" font-size="22" fill="#111">${esc(r)}</text>`,
    )
    .join("");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fbf8f1"/>${text}</svg>`,
  );
}

async function renderImage(rows, variant) {
  let img = sharp(svgOf(rows)).flatten({ background: "#fbf8f1" });
  if (variant.rotate) img = img.rotate(variant.rotate, { background: "#d8d2c4" });
  if (variant.crumple) {
    // „Mototolit” simulat: forfecare ușoară, estompare și contrast neuniform.
    img = img.affine([1, 0.06, 0.03, 1], { background: "#d8d2c4" }).blur(0.8).linear(0.85, 18);
  }
  if (variant.blur) img = img.blur(variant.blur);
  let buf = await img.png().toBuffer();
  if (variant.noise) {
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    // Zgomot determinist (LCG), fără Math.random.
    let seed = 12345;
    for (let i = 0; i < data.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const delta = (seed % 41) - 20;
      data[i] = Math.max(0, Math.min(255, data[i] + delta));
    }
    buf = await sharp(data, { raw: info }).png().toBuffer();
  }
  if (variant.format === "png") return { mime: "image/png", data: buf, ext: "png" };
  return {
    mime: "image/jpeg",
    data: await sharp(buf)
      .jpeg({ quality: variant.quality ?? 88 })
      .toBuffer(),
    ext: "jpg",
  };
}

const latin1 = (s) => Buffer.from(s, "latin1");

/** PDF cu text (bon electronic): un obiect de conținut cu câte un rând pe linie. */
function textPdf(rows) {
  const ops = rows
    .map(
      (r, i) =>
        `BT /F1 10 Tf 30 ${780 - i * 14} Td (${r
          .normalize("NFD")
          .replace(/[^\x20-\x7e]/g, "")
          .replace(/[()\\]/g, "")}) Tj ET`,
    )
    .join("\n");
  const content = latin1(ops);
  const objects = [
    latin1("<< /Type /Catalog /Pages 2 0 R >>"),
    latin1("<< /Type /Pages /Kids [4 0 R] /Count 1 >>"),
    latin1("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>"),
    latin1(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    ),
    Buffer.concat([
      latin1(`<< /Length ${content.length} >>\nstream\n`),
      content,
      latin1("\nendstream"),
    ]),
  ];
  const parts = [latin1("%PDF-1.4\n")];
  let length = parts[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(length);
    const b = Buffer.concat([latin1(`${i + 1} 0 obj\n`), body, latin1("\nendobj\n")]);
    parts.push(b);
    length += b.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  parts.push(
    latin1(
      `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

/**
 * Fișierele unui bon: unul singur sau, pentru bonul lung, părțile în ordine (antetul pe prima,
 * totalul pe ultima, `overlap` linii repetate la fiecare graniță, ca la poze suprapuse).
 */
export async function renderFixture(gt) {
  const { head, body, tail } = receiptRows(gt);
  const v = gt.variant;
  if (v.format === "pdf") {
    return [
      { name: `${gt.id}.pdf`, mime: "application/pdf", data: textPdf([...head, ...body, ...tail]) },
    ];
  }
  if (!v.parts) {
    const img = await renderImage([...head, ...body, ...tail], v);
    return [{ name: `${gt.id}.${img.ext}`, mime: img.mime, data: img.data }];
  }
  const per = Math.ceil(body.length / v.parts);
  const files = [];
  for (let p = 0; p < v.parts; p++) {
    const from = Math.max(0, p * per - (p > 0 ? v.overlap : 0));
    const chunk = body.slice(from, (p + 1) * per);
    const rows = [...(p === 0 ? head : []), ...chunk, ...(p === v.parts - 1 ? tail : [])];
    const img = await renderImage(rows, v);
    files.push({ name: `${gt.id}-${p + 1}.${img.ext}`, mime: img.mime, data: img.data });
  }
  return files;
}

/** `true` dacă fonturile de sistem desenează text (altfel imaginile n-au text). */
export async function fontsAvailable() {
  const { data } = await sharp(svgOf(["TEST 123"]))
    .flatten({ background: "#fbf8f1" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data.some((v) => v < 128);
}

async function main() {
  const out = process.argv[2] ?? join(process.cwd(), "fixtures/receipts/generated");
  mkdirSync(out, { recursive: true });
  if (!(await fontsAvailable())) {
    console.warn(
      "ATENȚIE: fără fonturi de sistem: imaginile nu au text (doar evaluarea mock are sens).",
    );
  }
  for (const gt of FIXTURES) {
    for (const f of await renderFixture(gt)) writeFileSync(join(out, f.name), f.data);
  }
  const truth = FIXTURES.map(({ variant, ...rest }) => ({ ...rest, variant }));
  writeFileSync(
    join(process.cwd(), "fixtures/receipts/ground-truth.json"),
    `${JSON.stringify({ note: "Bonuri SINTETICE (scripts/make-receipt-fixtures.mjs). Nu înlocuiesc evaluarea pe bonuri reale.", receipts: truth }, null, 2)}\n`,
  );
  console.log(`${FIXTURES.length} bonuri sintetice în ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
