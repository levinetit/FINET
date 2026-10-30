import "server-only";

import { deflateSync } from "node:zlib";

import { type ExportTable, type TableKind, assertTable } from "./export-table";

export { PDF_CONTENT_TYPE } from "./export-table";

/**
 * Scriitorul de PDF pentru exporturile din Faza 10 (F10-C; ADR 0024), FĂRĂ dependențe externe: un
 * tabel pe pagini A4, cu antetul repetat, text care se rupe pe rânduri și numerotarea paginilor.
 *
 * Alegeri:
 * - Fontul este Helvetica din cele 14 standard (fără font încorporat, deci fișier mic). Diacriticele
 *   românești nu există în WinAnsi (`ă`, `ș`, `ț`), așa că fontul are o codificare proprie (`/Differences`)
 *   care le pune pe coduri libere (1–6) cu numele de glifă Adobe (`abreve`, `scommaaccent`, …),
 *   prezente în Helvetica. Variantele cu sedilă (`ş`, `ţ`) se desenează cu aceleași glife. `â`, `î`
 *   sunt native în WinAnsi. Un caracter fără glifă devine `?`.
 * - Lățimile sunt cele Adobe Helvetica (AFM) pentru ASCII; literele accentuate iau lățimea literei
 *   de bază. Se folosește doar Helvetica normală (fără bold), deci măsurătoarea e exactă.
 * - Textul se scrie ca șiruri hexazecimale (nu există nimic de scăpat) și e comprimat (Flate).
 * - Determinist: fără dată de creare și fără identificator aleator.
 */

const MM = 72 / 25.4;
const PORTRAIT = { w: 210 * MM, h: 297 * MM };
const LANDSCAPE = { w: 297 * MM, h: 210 * MM };
const MARGIN = 36;
const MAX_LINES_PER_CELL = 3;
/** Plafonul rândurilor într-un PDF (peste el: exportul se cere în Excel/CSV). */
export const PDF_MAX_ROWS = 3_000;

// --- Codificarea fontului ---

/** Caracter → cod de octet în fontul nostru; `null` = fără glifă. */
const SPECIAL: Readonly<Record<string, number>> = {
  ă: 1,
  Ă: 2,
  ș: 3,
  Ș: 4,
  ț: 5,
  Ț: 6,
  ş: 3,
  Ş: 4,
  ţ: 5,
  Ţ: 6,
  "€": 0x80,
  "„": 0x84,
  "…": 0x85,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
};

const DIFFERENCES = "1 /abreve /Abreve /scommaaccent /Scommaaccent /tcommaaccent /Tcommaaccent";

export function encodeChar(ch: string): number {
  const special = SPECIAL[ch];
  if (special !== undefined) return special;
  const c = ch.codePointAt(0)!;
  if (c === 0x09 || c === 0x0a || c === 0x0d) return 0x20;
  if (c >= 0x20 && c <= 0x7e) return c;
  if (c >= 0xa0 && c <= 0xff) return c; // WinAnsi = Latin-1 în intervalul A0–FF
  return 0x3f; // '?'
}

// Lățimile Helvetica pentru ASCII 32–126 (mii de unități em).
const ASCII_WIDTHS: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const EXTRA_WIDTHS: Readonly<Record<number, number>> = {
  1: 556, // ă
  2: 667, // Ă
  3: 500, // ș
  4: 667, // Ș
  5: 278, // ț
  6: 611, // Ț
  0x80: 556,
  0x84: 333,
  0x85: 1000,
  0x91: 222,
  0x92: 222,
  0x93: 333,
  0x94: 333,
  0x95: 350,
  0x96: 556,
  0x97: 1000,
};

function codeWidth(code: number): number {
  if (code >= 0x20 && code <= 0x7e) return ASCII_WIDTHS[code - 0x20]!;
  const extra = EXTRA_WIDTHS[code];
  if (extra !== undefined) return extra;
  return 556; // litere accentuate Latin-1 și restul: cifră/literă medie
}

/** Lățimea unui caracter accentuat = a literei de bază (NFD), altfel lățimea codului. */
function charWidth(ch: string): number {
  const code = encodeChar(ch);
  if (code >= 0xa0 && code <= 0xff) {
    const base = ch.normalize("NFD")[0]!;
    const b = base.charCodeAt(0);
    if (b >= 0x20 && b <= 0x7e && base !== ch) return ASCII_WIDTHS[b - 0x20]!;
  }
  return codeWidth(code);
}

/** Lățimea unui text în puncte, la dimensiunea dată. */
export function textWidth(text: string, size: number): number {
  let sum = 0;
  for (const ch of text) sum += charWidth(ch);
  return (sum * size) / 1000;
}

function hex(text: string): string {
  let out = "";
  for (const ch of text) out += encodeChar(ch).toString(16).padStart(2, "0");
  return `<${out}>`;
}

// --- Aranjarea ---

type Line = Readonly<{ text: string; width: number }>;

/** Rupe un text pe rânduri de cel mult `maxWidth`; cel mult `MAX_LINES_PER_CELL`, cu „…” la capăt. */
export function wrap(text: string, maxWidth: number, size: number): Line[] {
  const lines: string[] = [];
  let current = "";
  const push = () => {
    lines.push(current);
    current = "";
  };
  const fits = (s: string) => textWidth(s, size) <= maxWidth;
  for (const word of text.replace(/\s+/g, " ").trim().split(" ")) {
    if (word === "") continue;
    const candidate = current === "" ? word : `${current} ${word}`;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current !== "") push();
    if (fits(word)) {
      current = word;
      continue;
    }
    // Cuvânt mai lat decât coloana: ruptură pe caractere.
    for (const ch of word) {
      if (!fits(current + ch) && current !== "") push();
      current += ch;
    }
  }
  if (current !== "" || lines.length === 0) push();
  if (lines.length > MAX_LINES_PER_CELL) {
    const kept = lines.slice(0, MAX_LINES_PER_CELL);
    let last = kept[MAX_LINES_PER_CELL - 1]!;
    while (last !== "" && !fits(`${last}…`)) last = [...last].slice(0, -1).join("");
    kept[MAX_LINES_PER_CELL - 1] = `${last}…`;
    return kept.map((t) => ({ text: t, width: textWidth(t, size) }));
  }
  return lines.map((t) => ({ text: t, width: textWidth(t, size) }));
}

const RIGHT_ALIGNED: ReadonlySet<TableKind> = new Set(["money", "int", "percent"]);

/** Formatul de afișare al unei celule (sume cu separator de mii și virgulă, ca în Romania). */
export function displayCell(kind: TableKind, value: string | number | null): string {
  if (value === null) return "";
  const s = String(value);
  if (kind === "money") {
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) return s;
    const whole = m[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    const frac = (m[3] ?? "").padEnd(2, "0").slice(0, 2);
    return `${m[1]}${whole},${frac}`;
  }
  if (kind === "percent") return `${s}%`;
  return s;
}

type Page = string[];

/** PDF-ul (octeți) pentru un tabel de export. */
export function tableToPdf(table: ExportTable): Uint8Array {
  assertTable(table);
  if (table.rows.length > PDF_MAX_ROWS) throw new Error("prea multe rânduri pentru PDF");
  const ncols = table.columns.length;
  const size = ncols > 9 ? 7 : 8;
  const lineH = size + 2.5;
  const pad = 3;
  const dim = ncols <= 5 ? PORTRAIT : LANDSCAPE;
  const usable = dim.w - 2 * MARGIN;

  // Lățimile coloanelor din conținut (primele 300 de rânduri), apoi încadrarea în pagină.
  const sample = table.rows.slice(0, 300);
  const desired = table.columns.map((c, i) => {
    let w = textWidth(c.label, size);
    for (const row of sample) w = Math.max(w, textWidth(displayCell(c.kind, row[i]!), size));
    if (table.totals) w = Math.max(w, textWidth(displayCell(c.kind, table.totals[i]!), size));
    return w + 2 * pad;
  });
  const fixed = table.columns.map((c) => c.kind !== "text");
  const fixedSum = desired.reduce((s, w, i) => s + (fixed[i] ? w : 0), 0);
  const textSum = desired.reduce((s, w, i) => s + (fixed[i] ? 0 : w), 0);
  const widths = desired.map((w, i) => {
    if (fixed[i]) return w;
    if (fixedSum + textSum <= usable) return w;
    const room = Math.max(usable - fixedSum, 50 * (ncols - fixed.filter(Boolean).length));
    return Math.max(50, (w / textSum) * room);
  });
  const total = widths.reduce((s, w) => s + w, 0);
  const scale = total > usable ? usable / total : 1;
  const colW = widths.map((w) => w * scale);
  const colX: number[] = [];
  colW.reduce((x, w, i) => {
    colX[i] = x;
    return x + w;
  }, MARGIN);
  const right = MARGIN + colW.reduce((s, w) => s + w, 0);

  const pages: Page[] = [];
  let ops: Page = [];
  let y = 0;
  const top = dim.h - MARGIN;
  const bottom = MARGIN + 18; // loc pentru subsol

  const text = (x: number, yy: number, s: string, sz: number) => {
    if (s === "") return;
    ops.push(`BT /F1 ${sz} Tf ${x.toFixed(2)} ${yy.toFixed(2)} Td ${hex(s)} Tj ET`);
  };
  const rule = (yy: number, gray: number) => {
    ops.push(
      `${gray} G 0.4 w ${MARGIN} ${yy.toFixed(2)} m ${right.toFixed(2)} ${yy.toFixed(2)} l S`,
    );
  };
  const newPage = () => {
    ops = [];
    pages.push(ops);
    y = top;
  };

  const cellLines = (cells: readonly (string | number | null)[], asLabels = false) =>
    cells.map((cell, i) => {
      const col = table.columns[i]!;
      const shown = asLabels ? String(cell ?? "") : displayCell(col.kind, cell);
      return wrap(shown, colW[i]! - 2 * pad, size);
    });
  const drawRow = (
    cells: readonly (string | number | null)[],
    fill: number | null,
    asLabels = false,
  ) => {
    const wrapped = cellLines(cells, asLabels);
    const rows = Math.max(...wrapped.map((l) => l.length));
    const h = rows * lineH + 3;
    if (fill !== null) {
      ops.push(
        `${fill} g ${MARGIN} ${(y - h).toFixed(2)} ${(right - MARGIN).toFixed(2)} ${h.toFixed(2)} re f 0 g`,
      );
    }
    wrapped.forEach((lines, i) => {
      const kind = table.columns[i]!.kind;
      lines.forEach((line, n) => {
        const baseline = y - 1.5 - size - n * lineH + 1;
        const x = RIGHT_ALIGNED.has(kind) ? colX[i]! + colW[i]! - pad - line.width : colX[i]! + pad;
        text(x, baseline, line.text, size);
      });
    });
    y -= h;
    rule(y, 0.8);
    return h;
  };
  const header = () => {
    drawRow(
      table.columns.map((c) => c.label),
      0.91,
      true,
    );
  };
  const heightOf = (cells: readonly (string | number | null)[]) =>
    Math.max(...cellLines(cells).map((l) => l.length)) * lineH + 3;

  newPage();
  text(MARGIN, y - 14, table.title, 14);
  y -= 22;
  for (const line of table.context) {
    for (const part of wrap(line, right - MARGIN, 9)) {
      text(MARGIN, y - 9, part.text, 9);
      y -= 12;
    }
  }
  y -= 8;
  header();
  for (const row of table.rows) {
    if (y - heightOf(row) < bottom) {
      newPage();
      header();
    }
    drawRow(row, null);
  }
  if (table.totals) {
    if (y - heightOf(table.totals) < bottom) {
      newPage();
      header();
    }
    drawRow(table.totals, 0.96);
  }
  // Subsol cu numerotarea (după ce se știe numărul paginilor).
  pages.forEach((page, i) => {
    ops = page;
    text(MARGIN, MARGIN, "FINET", 8);
    const label = `Pagina ${i + 1} din ${pages.length}`;
    text(right - textWidth(label, 8), MARGIN, label, 8);
  });

  return assemble(pages, dim, table.title);
}

// --- Structura fișierului PDF ---

/**
 * Harta cod → Unicode a fontului (`/ToUnicode`): fără ea, cititoarele de PDF scot din numele de
 * glifă `tcommaaccent` litera cu sedilă (U+0163), nu `ț` (U+021B). Căutarea și copierea textului
 * funcționează astfel cu diacriticele corecte.
 */
const TO_UNICODE = [
  "/CIDInit /ProcSet findresource begin",
  "12 dict begin",
  "begincmap",
  "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
  "/CMapName /Adobe-Identity-UCS def",
  "/CMapType 2 def",
  "1 begincodespacerange <00> <FF> endcodespacerange",
  "2 beginbfrange <20> <7E> <0020> <A0> <FF> <00A0> endbfrange",
  "16 beginbfchar",
  "<01> <0103> <02> <0102> <03> <0219> <04> <0218> <05> <021B> <06> <021A>",
  "<80> <20AC> <84> <201E> <85> <2026> <91> <2018> <92> <2019> <93> <201C> <94> <201D>",
  "<95> <2022> <96> <2013> <97> <2014>",
  "endbfchar",
  "endcmap",
  "CMapName currentdict /CMap defineresource pop",
  "end",
  "end",
].join("\n");

/** Șir text PDF în UTF-16BE cu BOM (pentru metadate, unde codificarea fontului nu se aplică). */
function utf16Hex(text: string): string {
  let out = "FEFF";
  for (let i = 0; i < text.length; i += 1) out += text.charCodeAt(i).toString(16).padStart(4, "0");
  return `<${out}>`;
}

function assemble(
  pages: readonly Page[],
  dim: { w: number; h: number },
  title: string,
): Uint8Array {
  // Obiecte: 1 catalog, 2 pagini, 3 font, 4 info, apoi (pagină, conținut) perechi.
  const objects: Buffer[] = [];
  const add = (body: string | Buffer): number => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"));
    return objects.length;
  };
  const firstPage = 6;
  const kids = pages.map((_, i) => `${firstPage + 2 * i} 0 R`).join(" ");
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding " +
      `/BaseEncoding /WinAnsiEncoding /Differences [ ${DIFFERENCES} ] >> /ToUnicode 5 0 R >>`,
  );
  add(`<< /Title ${utf16Hex(title)} /Producer (FINET) >>`);
  const cmap = deflateSync(Buffer.from(TO_UNICODE, "latin1"));
  add(
    Buffer.concat([
      Buffer.from(`<< /Length ${cmap.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
      cmap,
      Buffer.from("\nendstream", "latin1"),
    ]),
  );
  pages.forEach((page, i) => {
    const content = deflateSync(Buffer.from(page.join("\n"), "latin1"));
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${dim.w.toFixed(2)} ${dim.h.toFixed(2)}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${firstPage + 2 * i + 1} 0 R >>`,
    );
    add(
      Buffer.concat([
        Buffer.from(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
        content,
        Buffer.from("\nendstream", "latin1"),
      ]),
    );
  });

  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets: number[] = [];
  let pos = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(pos);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, "latin1"),
      body,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    parts.push(chunk);
    pos += chunk.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}
