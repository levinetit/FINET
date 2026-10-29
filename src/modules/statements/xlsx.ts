import type { Table } from "./csv";
import { cleanItemText } from "./text";
import { StatementError } from "./types";
import { type ZipEntry, isZip, readZip } from "./zip";

/**
 * Citirea SIGURĂ a unui XLSX (ADR 0018), fără dependențe noi: pachetul OOXML se deschide cu
 * `readZip` (aceleași plafoane și verificări), apoi se citesc DOAR `xl/sharedStrings.xml` și
 * prima foaie, cu un cititor XML minimal care REFUZĂ orice `<!DOCTYPE`/`<!ENTITY` (fără XXE și
 * fără „billion laughs”) și decodează doar entitățile XML predefinite și cele numerice.
 * Se folosesc doar valorile celulelor: formulele NU se evaluează (se ia valoarea salvată, ca
 * text), macro-urile (`vbaProject.bin`, `.xlsm`) și obiectele externe sunt refuzate.
 * Plafoane pe foi, rânduri, coloane și lungimea celulelor.
 */

export const XLSX_LIMITS = Object.freeze({
  maxEntries: 200,
  maxEntryBytes: 30 * 1024 * 1024,
  maxTotalBytes: 60 * 1024 * 1024,
  maxRatio: 200,
  maxSheets: 20,
  maxRows: 10_000,
  maxColumns: 50,
  maxSharedStrings: 200_000,
  maxCellChars: 1000,
  /** Mărimea decomprimată maximă a foii și a `sharedStrings.xml` (decizia mea). */
  maxPartBytes: 8 * 1024 * 1024,
  maxCells: 500_000,
});

const unsafe = (): never => {
  throw new StatementError("xlsx_unsafe");
};
const invalid = (): never => {
  throw new StatementError("xlsx_invalid");
};

/** E un pachet XLSX (ZIP cu `[Content_Types].xml` și `xl/workbook.xml`)? */
export function looksLikeXlsx(entries: readonly ZipEntry[]): boolean {
  const names = new Set(entries.map((e) => e.name));
  return names.has("[Content_Types].xml") && names.has("xl/workbook.xml");
}

function xmlText(data: Buffer): string {
  const s = data.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) unsafe();
  return s;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|lt|gt|amp|quot|apos);|&/g, (m, e?: string) => {
    if (e === undefined) return invalid();
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "amp") return "&";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (!(code > 0 && code <= 0x10ffff)) return invalid();
    return String.fromCodePoint(code);
  });
}

/**
 * Elementele `<name …>…</name>` (sau `<name/>`) dintr-un text, într-o SINGURĂ trecere liniară
 * cu `indexOf` (fără expresii regulate cu `[\s\S]*?` pe date neîncrezătoare: ReDoS). Un tag
 * neînchis = fișier invalid (eșec imediat). `max` plafonează numărul de elemente în timpul
 * parcurgerii.
 */
export function* elements(
  s: string,
  name: string,
  max: number,
): Generator<Readonly<{ attrs: string; body: string }>> {
  const open = `<${name}`;
  const close = `</${name}>`;
  let pos = 0;
  let n = 0;
  for (;;) {
    const i = s.indexOf(open, pos);
    if (i < 0) return;
    const after = s.charCodeAt(i + open.length);
    // `<c` nu trebuie să potrivească `<col`: după nume urmează spațiu, `>` sau `/`.
    if (
      after !== 0x20 &&
      after !== 0x3e &&
      after !== 0x2f &&
      after !== 0x09 &&
      after !== 0x0a &&
      after !== 0x0d
    ) {
      pos = i + open.length;
      continue;
    }
    const tagEnd = s.indexOf(">", i);
    if (tagEnd < 0 || tagEnd - i > MAX_TAG_CHARS) invalid();
    if (++n > max) unsafe();
    const attrs = s.slice(i + open.length, tagEnd);
    if (s.charCodeAt(tagEnd - 1) === 0x2f) {
      yield { attrs: attrs.slice(0, -1), body: "" };
      pos = tagEnd + 1;
      continue;
    }
    const end = s.indexOf(close, tagEnd + 1);
    if (end < 0) invalid();
    yield { attrs, body: s.slice(tagEnd + 1, end) };
    pos = end + close.length;
  }
}

const MAX_TAG_CHARS = 2000;

/** Textul tuturor nodurilor `<t>` dintr-un fragment (șiruri cu formatare „rich”). */
function texts(fragment: string): string {
  let out = "";
  for (const t of elements(fragment, "t", 10_000)) {
    out += decodeEntities(t.body);
    if (out.length > XLSX_LIMITS.maxCellChars) invalid();
  }
  return out;
}

function columnIndex(ref: string): number {
  const letters = /^([A-Z]{1,3})\d+$/.exec(ref)?.[1];
  if (!letters) return invalid();
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

const cell = (s: string): string => {
  if (s.length > XLSX_LIMITS.maxCellChars) invalid();
  return cleanItemText(s);
};

export function parseXlsx(bytes: Uint8Array): Table {
  if (!isZip(bytes)) invalid();
  const L = XLSX_LIMITS;
  let entries: ZipEntry[];
  try {
    entries = readZip(bytes, {
      maxEntries: L.maxEntries,
      maxEntryBytes: L.maxEntryBytes,
      maxTotalBytes: L.maxTotalBytes,
      maxRatio: L.maxRatio,
      allowNested: false,
    });
  } catch (e) {
    if (e instanceof StatementError && e.code === "zip_unsafe") unsafe();
    return invalid();
  }
  if (!looksLikeXlsx(entries)) invalid();
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  // Macro-uri, obiecte încorporate, legături externe: refuz.
  if (
    entries.some((e) =>
      /vbaProject\.bin$|^xl\/activeX\/|^xl\/embeddings\/|^xl\/externalLinks\//i.test(e.name),
    )
  ) {
    unsafe();
  }
  const contentTypes = xmlText(byName.get("[Content_Types].xml")!);
  if (/macroEnabled/i.test(contentTypes)) unsafe();
  for (const e of entries) if (/\.(xml|rels)$/i.test(e.name)) xmlText(e.data);

  const sheets = entries
    .map((e) => e.name)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
  if (sheets.length === 0) invalid();
  if (sheets.length > L.maxSheets) unsafe();

  const shared: string[] = [];
  const sst = byName.get("xl/sharedStrings.xml");
  if (sst) {
    if (sst.length > L.maxPartBytes) unsafe();
    for (const si of elements(xmlText(sst), "si", L.maxSharedStrings)) shared.push(texts(si.body));
  }

  const sheetData = byName.get(sheets[0]!)!;
  if (sheetData.length > L.maxPartBytes) unsafe();
  const sheet = xmlText(sheetData);
  const rows: string[][] = [];
  let cells = 0;
  for (const r of elements(sheet, "row", L.maxRows + 1)) {
    const out: string[] = [];
    for (const c of elements(r.body, "c", L.maxColumns * 4)) {
      if (++cells > L.maxCells) unsafe();
      const ref = /\br="([A-Z]{1,3}\d+)"/.exec(c.attrs)?.[1];
      const type = /\bt="(\w{1,12})"/.exec(c.attrs)?.[1] ?? "n";
      const idx = ref ? columnIndex(ref) : out.length;
      if (idx >= L.maxColumns) unsafe();
      let v: string | undefined;
      for (const e of elements(c.body, "v", 1)) v = e.body;
      let value = "";
      if (type === "s") {
        const k = Number(v);
        if (!Number.isSafeInteger(k) || k < 0 || k >= shared.length) invalid();
        value = shared[k]!;
      } else if (type === "inlineStr") value = texts(c.body);
      else if (v !== undefined) value = decodeEntities(v); // n, b, str, e: valoarea salvată
      while (out.length < idx) out.push("");
      out[idx] = cell(value);
    }
    if (out.some((x) => x !== "")) rows.push(out);
    if (rows.length > L.maxRows) throw new StatementError("too_many_lines");
  }
  if (rows.length === 0) throw new StatementError("empty_statement");
  return { rows, delimiter: null };
}
