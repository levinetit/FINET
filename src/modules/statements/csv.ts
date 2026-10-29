import { cleanItemText } from "./text";
import { StatementError } from "./types";

/**
 * Citirea CSV generică (ADR 0018): encodare (UTF-8 cu/fără BOM, UTF-16 LE cu BOM, altfel
 * Windows-1250, encodarea exporturilor românești vechi), delimitator (`;`, `,`, tab, `|`, ales
 * după consecvența pe primele rânduri), ghilimele RFC 4180, plafoane pe octeți/rânduri/coloane/
 * celulă. Celulele se curăță de caractere de control; NU se interpretează niciodată (o celulă
 * `=…` rămâne text; protecția la export e în `src/modules/exports`).
 */

export const CSV_LIMITS = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  maxRows: 10_000,
  maxColumns: 50,
  maxCellChars: 1000,
});

export type Table = Readonly<{ rows: readonly (readonly string[])[]; delimiter: string | null }>;

export function decodeText(bytes: Uint8Array): string {
  if (bytes.length > CSV_LIMITS.maxBytes) throw new StatementError("file_too_large");
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  // Octeți NUL într-un fișier care nu e UTF-16 = fișier binar, nu text.
  if (bytes.includes(0)) throw new StatementError("csv_invalid");
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start));
  } catch {
    return new TextDecoder("windows-1250").decode(bytes);
  }
}

const DELIMITERS = [";", ",", "\t", "|"] as const;

/** Numărul de delimitatori în afara ghilimelelor, pe un rând. */
function countOutside(line: string, d: string): number {
  let n = 0;
  let quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (c === d && !quoted) n++;
  }
  return n;
}

/** Delimitatorul cu număr constant (> 0) pe cele mai multe dintre primele 20 de rânduri. */
export function detectDelimiter(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(0, 20);
  let best: { d: string; score: number } | null = null;
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => countOutside(l, d));
    const freq = new Map<number, number>();
    for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1);
    const top = Math.max(0, ...freq.values());
    if (top > 0 && (!best || top > best.score)) best = { d, score: top };
  }
  return best?.d ?? null;
}

export function parseCsv(bytes: Uint8Array): Table {
  const text = decodeText(bytes);
  const delimiter = detectDelimiter(text);
  const L = CSV_LIMITS;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const pushCell = () => {
    if (cell.length > L.maxCellChars) throw new StatementError("csv_invalid");
    row.push(cleanItemText(cell));
    cell = "";
    if (row.length > L.maxColumns) throw new StatementError("csv_invalid");
  };
  const pushRow = () => {
    pushCell();
    if (row.some((c) => c !== "")) rows.push(row);
    row = [];
    if (rows.length > L.maxRows) throw new StatementError("too_many_lines");
  };
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === "") quoted = true;
    else if (delimiter !== null && c === delimiter) pushCell();
    else if (c === "\n" || c === "\r") {
      pushRow();
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else cell += c;
    i++;
  }
  if (quoted) throw new StatementError("csv_invalid");
  if (cell !== "" || row.length) pushRow();
  if (rows.length === 0) throw new StatementError("empty_statement");
  return { rows, delimiter };
}
