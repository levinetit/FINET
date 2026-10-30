import "server-only";

import { deflateRawSync } from "node:zlib";

import { type ExportTable, assertTable, excelSerial } from "./export-table";

export { XLSX_CONTENT_TYPE } from "./export-table";

/**
 * Scriitorul de fișiere Excel (.xlsx, Office Open XML) pentru exporturile din Faza 10 (F10-C;
 * ADR 0024), FĂRĂ dependențe externe: un arhiv ZIP cu `node:zlib` și câteva fișiere XML.
 *
 * Alegeri:
 * - O singură foaie per fișier, cu texte INLINE (`t="inlineStr"`): nu există tabel de șiruri comune.
 *   O celulă de text nu este niciodată formulă: un nume care începe cu `=` rămâne text (spre
 *   deosebire de CSV, nu e nevoie de apostroful din `csv.ts`).
 * - Sumele sunt celule numerice cu formatul `#,##0.00`; valoarea se scrie exact ca text zecimal
 *   (din unități minore bigint), nu trece prin float în aplicație.
 * - Caractere interzise în XML 1.0 (controale, surogate singure) sunt ELIMINATE, altfel Excel
 *   refuză fișierul. Numele foii: ≤ 31 de caractere, fără `[]:*?/\`.
 * - Antet înghețat și filtru automat; lățimile coloanelor din conținut (plafonate).
 * - Determinist: aceeași intrare dă aceiași octeți (data fișierelor din arhiv e fixă).
 */

/**
 * Plafonul rândurilor într-un fișier Excel (F10-C): măsurat, 20.000 de rânduri × 10 coloane ocupă
 * ~133 MB RSS și ~1 s (50.000: ~240 MB, 2,8 s), iar `finet-web` are 512 MB.
 */
export const XLSX_MAX_ROWS = 20_000;

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Eliminarea caracterelor care nu au voie în XML 1.0. */
export function xmlSafe(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[i]! + value[i + 1]!;
        i += 1;
      }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    if (c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c <= 0xfffd)) out += value[i]!;
  }
  return out;
}

export function xmlEscape(value: string): string {
  return xmlSafe(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Numele foii: fără caractere interzise, 1–31 de caractere. */
export function sheetName(title: string): string {
  const cleaned = xmlSafe(title)
    .replace(/[[\]:*?/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^'+|'+$/g, "");
  return (cleaned === "" ? "Export" : cleaned).slice(0, 31);
}

/** Litera coloanei Excel (0 → A, 25 → Z, 26 → AA). */
export function columnLetter(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

// Stilurile (indici în cellXfs): 0 implicit, 1 antet, 2 sumă, 3 dată, 4 întreg, 5 procent, 6 titlu, 7 total sumă, 8 total text.
const S = {
  text: 0,
  header: 1,
  money: 2,
  date: 3,
  int: 4,
  percent: 5,
  title: 6,
  totalMoney: 7,
  totalText: 8,
} as const;

const STYLES = `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF4"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function inline(ref: string, style: number, value: string): string {
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function numeric(ref: string, style: number, value: string | number): string {
  return `<c r="${ref}" s="${style}"><v>${String(value)}</v></c>`;
}

const MAX_WIDTH = 60;
const MIN_WIDTH = 8;

function sheetXml(table: ExportTable): string {
  const ncols = table.columns.length;
  const widths = table.columns.map((c) => Math.max(MIN_WIDTH, c.label.length + 2));
  const rows: string[] = [];
  let r = 1;
  const row = (cells: string[]) => {
    rows.push(`<row r="${r}">${cells.join("")}</row>`);
    r += 1;
  };

  row([inline(`A${r}`, S.title, table.title)]);
  for (const line of table.context) row([inline(`A${r}`, S.text, line)]);
  if (table.context.length > 0) r += 1; // rând liber între context și antet
  const headerRow = r;
  row(table.columns.map((c, i) => inline(`${columnLetter(i)}${r}`, S.header, c.label)));

  const body = (cells: readonly (string | number | null)[], total: boolean) => {
    const out: string[] = [];
    cells.forEach((cell, i) => {
      if (cell === null) return;
      const ref = `${columnLetter(i)}${r}`;
      const kind = table.columns[i]!.kind;
      const text = String(cell);
      widths[i] = Math.max(widths[i]!, Math.min(MAX_WIDTH, kind === "date" ? 12 : text.length + 2));
      if (kind === "text") out.push(inline(ref, total ? S.totalText : S.text, text));
      else if (kind === "date") out.push(numeric(ref, S.date, excelSerial(text)));
      else if (kind === "money") out.push(numeric(ref, total ? S.totalMoney : S.money, text));
      else if (kind === "percent") out.push(numeric(ref, S.percent, text));
      else out.push(numeric(ref, S.int, text));
    });
    row(out);
  };
  for (const cells of table.rows) body(cells, false);
  const lastDataRow = r - 1;
  if (table.totals) body(table.totals, true);

  const cols = widths
    .map(
      (w, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${Math.min(MAX_WIDTH, w)}" customWidth="1"/>`,
    )
    .join("");
  const last = `${columnLetter(ncols - 1)}${Math.max(headerRow, lastDataRow)}`;
  const filter = table.rows.length > 0 ? `<autoFilter ref="A${headerRow}:${last}"/>` : "";
  const pane = `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/>`;
  return (
    `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
    `<cols>${cols}</cols><sheetData>${rows.join("")}</sheetData>${filter}</worksheet>`
  );
}

// --- ZIP minimal (metoda 8, deflate), cu sume CRC-32 ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 1980-01-01 00:00:00 (formatul DOS): arhivul e determinist.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export type ZipEntry = Readonly<{ name: string; data: Uint8Array }>;

export function zip(entries: readonly ZipEntry[]): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.from(e.data);
    const packed = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versiunea necesară
    local.writeUInt16LE(0x0800, 6); // nume UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, packed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += local.length + name.length + packed.length;
  }
  const centralSize = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/** Fișierul .xlsx (octeți) pentru un tabel de export. */
export function tableToXlsx(table: ExportTable): Uint8Array {
  assertTable(table);
  const name = xmlEscape(sheetName(table.title));
  return zip([
    {
      name: "[Content_Types].xml",
      data: utf8(
        `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
      ),
    },
    {
      name: "_rels/.rels",
      data: utf8(
        `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ),
    },
    {
      name: "xl/workbook.xml",
      data: utf8(
        `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          `<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: utf8(
        `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
      ),
    },
    { name: "xl/styles.xml", data: utf8(STYLES) },
    { name: "xl/worksheets/sheet1.xml", data: utf8(sheetXml(table)) },
  ]);
}
