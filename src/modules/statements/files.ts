import { type MappingSuggestion, suggestMapping } from "./mapping";
import { type Table, parseCsv } from "./csv";
import { StatementError } from "./types";
import { parseXlsx } from "./xlsx";
import { isZip, readZip } from "./zip";

/**
 * Încărcarea unui extras: tipul se stabilește după CONȚINUT (nu după extensie sau tipul MIME
 * declarat): PDF (`%PDF-`), ZIP (`PK\x03\x04`; dacă e pachet OOXML cu `xl/workbook.xml` = XLSX),
 * altfel text CSV. Un ZIP de extrase se desface în siguranță (`readZip`) și fiecare fișier se
 * tratează separat; arhivele imbricate (inclusiv XLSX într-un ZIP) sunt refuzate. PDF-urile se
 * citesc DOAR în worker (procesul copil limitat), deci aici rămân octeți de trimis acolo.
 */

export type UploadPart =
  | Readonly<{ index: number; kind: "pdf"; bytes: Buffer }>
  | Readonly<{
      index: number;
      kind: "table";
      format: "csv" | "xlsx";
      table: Table;
      suggestion: MappingSuggestion;
    }>;

const isPdf = (b: Uint8Array) =>
  b.length >= 5 &&
  b[0] === 0x25 &&
  b[1] === 0x50 &&
  b[2] === 0x44 &&
  b[3] === 0x46 &&
  b[4] === 0x2d;

/** Plafonul fișierului încărcat (înainte de orice citire). */
export const STATEMENT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

function single(bytes: Buffer, index: number, inZip: boolean): UploadPart {
  if (isPdf(bytes)) return { index, kind: "pdf", bytes };
  if (isZip(bytes)) {
    if (inZip) throw new StatementError("zip_unsafe");
    const table = parseXlsx(bytes);
    return { index, kind: "table", format: "xlsx", table, suggestion: suggestMapping(table) };
  }
  const table = parseCsv(bytes);
  return { index, kind: "table", format: "csv", table, suggestion: suggestMapping(table) };
}

export function readStatementUpload(input: Uint8Array): UploadPart[] {
  if (input.byteLength > STATEMENT_UPLOAD_MAX_BYTES) throw new StatementError("file_too_large");
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (isZip(bytes)) {
    let entries;
    try {
      entries = readZip(bytes);
    } catch (e) {
      // Un XLSX are propriile plafoane: dacă arhiva arată ca un pachet OOXML, îl citim ca XLSX.
      if (e instanceof StatementError && e.code === "zip_unsafe") {
        try {
          return [single(bytes, 0, false)];
        } catch (inner) {
          if (inner instanceof StatementError && inner.code === "xlsx_invalid") throw e;
          throw inner;
        }
      }
      throw e;
    }
    if (entries.some((x) => x.name === "[Content_Types].xml")) return [single(bytes, 0, false)];
    const files = entries.filter((x) => !x.name.startsWith("__MACOSX/"));
    if (files.length === 0) throw new StatementError("empty_statement");
    return files.map((x, i) => single(x.data, i, true));
  }
  return [single(bytes, 0, false)];
}
