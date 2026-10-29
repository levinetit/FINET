import { crc32, deflateRawSync } from "node:zlib";

import { buildPdf } from "@/modules/documents/testing";

import type { TextItem } from "./types";

/**
 * Doar pentru teste: un PDF cu text la pozițiile date (Helvetica 8 pt, WinAnsiEncoding), din
 * elementele unui fixture sintetic. Caracterele fără loc în WinAnsi (ă, ș, ț) se transliterează
 * (parserele pliază oricum diacriticele), `€` devine codul WinAnsi 0x80. Nu se importă din codul
 * aplicației.
 */
const TRANSLIT: Readonly<Record<string, string>> = {
  ă: "a",
  Ă: "A",
  ș: "s",
  Ș: "S",
  ț: "t",
  Ț: "T",
  "€": "\x80",
};

const latin1 = (s: string) => Buffer.from(s, "latin1");

function pdfString(s: string): string {
  const t = [...s].map((c) => TRANSLIT[c] ?? (c.charCodeAt(0) <= 0xff ? c : "?")).join("");
  return t.replace(/[()\\]/g, (c) => `\\${c}`);
}

export function itemsToPdf(items: readonly TextItem[], pageCount?: number): Buffer {
  const pages = pageCount ?? Math.max(1, ...items.map((i) => i.p));
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ");
  const objects: Buffer[] = [
    latin1("<< /Type /Catalog /Pages 2 0 R >>"),
    latin1(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`),
    latin1("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
  ];
  for (let p = 1; p <= pages; p++) {
    objects.push(
      latin1(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + (p - 1) * 2} 0 R >>`,
      ),
    );
    const ops = items
      .filter((i) => i.p === p)
      .map((i) => `BT /F1 8 Tf 1 0 0 1 ${i.x} ${i.y} Tm (${pdfString(i.s)}) Tj ET`)
      .join("\n");
    const data = latin1(ops);
    objects.push(
      Buffer.concat([
        latin1(`<< /Length ${data.length} >>\nstream\n`),
        data,
        latin1("\nendstream"),
      ]),
    );
  }
  return buildPdf(objects);
}

// ---------------------------------------------------------------------------------------------
// ZIP / XLSX construite în test (inclusiv variante ostile)
// ---------------------------------------------------------------------------------------------

export type ZipSpec = Readonly<{
  name: string;
  data: Buffer | string;
  /** 0 = stocat, 8 = deflate (implicit). */
  method?: 0 | 8;
  flags?: number;
  /** Atributele externe (de exemplu `0o120777 << 16` = legătură simbolică). */
  external?: number;
  /** Mărimea decomprimată DECLARATĂ (pentru minciuni). */
  declaredSize?: number;
  crc?: number;
  /** Folosește datele intrării cu acest index (intrări suprapuse). */
  sameDataAs?: number;
}>;

export function buildZip(specs: readonly ZipSpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;
  specs.forEach((s) => {
    const raw = Buffer.isBuffer(s.data) ? s.data : Buffer.from(s.data, "utf8");
    const method = s.method ?? 8;
    const comp = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(s.name, "utf8");
    const crc = s.crc ?? crc32(raw);
    const usize = s.declaredSize ?? raw.length;
    const flags = (s.flags ?? 0) | 0x0800;
    let localOffset = offset;
    if (s.sameDataAs !== undefined) localOffset = offsets[s.sameDataAs]!;
    else {
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(flags, 6);
      h.writeUInt16LE(method, 8);
      h.writeUInt32LE(crc >>> 0, 14);
      h.writeUInt32LE(comp.length, 18);
      h.writeUInt32LE(usize, 22);
      h.writeUInt16LE(name.length, 26);
      locals.push(h, name, comp);
      offset += 30 + name.length + comp.length;
    }
    offsets.push(localOffset);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc >>> 0, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(usize, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(s.external ?? 0, 38);
    c.writeUInt32LE(localOffset, 42);
    centrals.push(c, name);
  });
  const cd = Buffer.concat(centrals);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(specs.length, 8);
  e.writeUInt16LE(specs.length, 10);
  e.writeUInt32LE(cd.length, 12);
  e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, e]);
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Un XLSX minimal (o foaie, șiruri partajate) cu rândurile date; `extra` = părți suplimentare. */
export function buildXlsx(
  rows: readonly (readonly (string | number)[])[],
  extra: readonly ZipSpec[] = [],
  sheetXmlPrefix = "",
): Buffer {
  const shared: string[] = [];
  const cells = rows
    .map((r, ri) => {
      const cs = r
        .map((v, ci) => {
          const ref = `${String.fromCharCode(65 + ci)}${ri + 1}`;
          if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
          shared.push(v);
          return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
        })
        .join("");
      return `<row r="${ri + 1}">${cs}</row>`;
    })
    .join("");
  const sst = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((s) => `<si><t>${xmlEscape(s)}</t></si>`).join("")}</sst>`;
  return buildZip([
    {
      name: "[Content_Types].xml",
      data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    },
    {
      name: "xl/workbook.xml",
      data: '<?xml version="1.0"?><workbook><sheets><sheet name="S" sheetId="1"/></sheets></workbook>',
    },
    { name: "xl/sharedStrings.xml", data: sst },
    {
      name: "xl/worksheets/sheet1.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?>${sheetXmlPrefix}<worksheet><sheetData>${cells}</sheetData></worksheet>`,
    },
    ...extra,
  ]);
}
