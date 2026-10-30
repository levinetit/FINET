/**
 * Modelul comun al exporturilor tabelare (Faza 10, F10-C; ADR 0024): un titlu, câteva rânduri de
 * context și un tabel cu coloane tipate. Același obiect se scrie ca Excel (`xlsx.ts`) sau PDF
 * (`pdf.ts`); CSV-ul din Faza 3 rămâne pe `csv.ts`. Fără dependențe și fără acces la bază: se
 * poate folosi și din componente de test.
 *
 * Valorile sunt deja formatate de apelant în forma lor EXACTĂ:
 * - `text`: șir liber (nume, comerciant, descriere);
 * - `int`: număr întreg (sub forma de șir sau număr);
 * - `money`: suma zecimală exactă ca șir (`"-12.34"`), calculată din unități minore bigint; nu trece
 *   prin float și are mereu două zecimale;
 * - `date`: `YYYY-MM-DD`;
 * - `percent`: număr întreg (0–100 sau mai mult) ca șir/număr; semnul `%` stă în eticheta coloanei.
 * `null` înseamnă celulă goală.
 */

export const TABLE_KINDS = ["text", "int", "money", "date", "percent"] as const;
export type TableKind = (typeof TABLE_KINDS)[number];

export type TableColumn = Readonly<{
  /** Cod stabil (ASCII), pentru teste și pentru exporturile automate. */
  key: string;
  /** Eticheta afișată în antet (română). */
  label: string;
  kind: TableKind;
}>;

export type TableCell = string | number | null;

export type ExportTable = Readonly<{
  /** Titlul documentului (și numele foii Excel, curățat). */
  title: string;
  /** Rânduri de context sub titlu (perioada, gospodăria, data generării): doar text. */
  context: readonly string[];
  columns: readonly TableColumn[];
  rows: readonly (readonly TableCell[])[];
  /** Rând final de totaluri (aceleași coloane), opțional. */
  totals?: readonly TableCell[];
}>;

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** O valoare numerică exactă? (întreg sau zecimal, fără exponent, fără spații). */
export function isDecimal(value: TableCell): value is string | number {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && DECIMAL.test(value);
}

/**
 * Verifică forma unui tabel: fiecare rând are tot atâtea celule câte coloane, iar celulele numerice
 * sunt numere exacte. Aruncă `Error` cu un mesaj fără conținutul celulelor.
 */
export function assertTable(table: ExportTable): void {
  const width = table.columns.length;
  if (width === 0) throw new Error("tabel fără coloane");
  const check = (cells: readonly TableCell[], where: string) => {
    if (cells.length !== width)
      throw new Error(`${where}: ${cells.length} celule, ${width} coloane`);
    cells.forEach((cell, i) => {
      const kind = table.columns[i]!.kind;
      if (cell === null) return;
      if (kind === "text") {
        if (typeof cell !== "string") throw new Error(`${where}, coloana ${i}: text așteptat`);
      } else if (kind === "date") {
        if (typeof cell !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(cell)) {
          throw new Error(`${where}, coloana ${i}: dată așteptată`);
        }
      } else if (!isDecimal(cell)) {
        throw new Error(`${where}, coloana ${i}: număr exact așteptat`);
      }
    });
  };
  table.rows.forEach((row, i) => check(row, `rând ${i + 1}`));
  if (table.totals) check(table.totals, "totaluri");
}

/** `YYYY-MM-DD` → numărul de zile din sistemul Excel 1900 (1 = 1900-01-01, cu eroarea 1900 păstrată). */
export function excelSerial(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, d);
  const days = Math.round((ms - Date.UTC(1899, 11, 30)) / 86_400_000);
  return days;
}

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PDF_CONTENT_TYPE = "application/pdf";
