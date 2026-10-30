import type { ExportTable } from "@/lib/export-table";

import { CSV_BOM, type CsvDialect, csvHeader, csvRow, raw, text } from "./csv";

/**
 * Un `ExportTable` ca CSV (F10-C): aceleași reguli ca exporturile din Faza 3 (BOM, CRLF, ghilimele
 * RFC 4180, protecție contra formulelor pe textul liber). Antetul are CODURILE stabile ale
 * coloanelor, nu etichetele; sumele sunt zecimale exacte, cu separatorul dialectului. Rândurile de
 * context și de totaluri nu intră în CSV (rămân în Excel/PDF).
 */
export function tableToCsv(table: ExportTable, dialect: CsvDialect = "rfc4180"): string {
  let out =
    CSV_BOM +
    csvHeader(
      table.columns.map((c) => c.key),
      dialect,
    );
  for (const row of table.rows) {
    out += csvRow(
      row.map((cell, i) => {
        const kind = table.columns[i]!.kind;
        if (kind === "text") return text(cell === null ? null : String(cell));
        if (cell !== null && kind === "money" && dialect === "ro") {
          return raw(String(cell).replace(".", ","));
        }
        return raw(cell);
      }),
      dialect,
    );
  }
  return out;
}
