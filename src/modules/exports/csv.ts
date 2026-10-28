import { type Money, toDecimalString } from "@/lib/money";

/**
 * Scrierea CSV a exporturilor FINET (Faza 3; ADR 0007), fără dependențe externe.
 *
 * - UTF-8 cu BOM (`﻿`) la începutul fișierului, ca Excel să citească diacriticele.
 * - Rânduri terminate cu CRLF; o celulă se pune între ghilimele dacă are separatorul, `"`, CR sau
 *   LF, iar `"` din interior se dublează (RFC 4180).
 * - Dialectul implicit `rfc4180`: separator virgulă, zecimale cu punct (brief-ul F3-A). Dialectul
 *   `ro` (master prompt 5.3): separator `;`, zecimale cu virgulă. Ambele au aceleași coloane.
 * - Protecția contra CSV/formula injection (OWASP): o celulă de TEXT LIBER (nume, comerciant,
 *   descriere, note, etichete) care începe cu `=`, `+`, `-`, `@`, TAB sau CR primește în față un
 *   apostrof (`'`), deci nu mai e interpretată ca formulă. Valorile generate de aplicație (id-uri,
 *   date, enumerări, sume) NU se prefixează: o sumă negativă rămâne număr (`-12.34`).
 */

export const CSV_BOM = "﻿";
export const CSV_DIALECTS = ["rfc4180", "ro"] as const;
export type CsvDialect = (typeof CSV_DIALECTS)[number];

const DELIMITER: Readonly<Record<CsvDialect, string>> = { rfc4180: ",", ro: ";" };

/** O celulă: text liber (protejat contra injecției) sau valoare generată. */
export type CsvCell = Readonly<{ text: string | null }> | Readonly<{ raw: string | number | null }>;

export const text = (value: string | null | undefined): CsvCell => ({ text: value ?? null });
export const raw = (value: string | number | bigint | boolean | null | undefined): CsvCell => ({
  raw: value === null || value === undefined ? null : String(value),
});

const INJECTION_START = /^[=+\-@\t\r]/;

/** Neutralizează o celulă de text liber care ar putea fi interpretată ca formulă. */
export function neutralize(value: string): string {
  return INJECTION_START.test(value) ? `'${value}` : value;
}

function quote(value: string, delimiter: string): string {
  if (value.includes(delimiter) || /["\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function csvRow(cells: readonly CsvCell[], dialect: CsvDialect = "rfc4180"): string {
  const d = DELIMITER[dialect];
  return (
    cells
      .map((c) => {
        if ("text" in c) return c.text === null ? "" : quote(neutralize(c.text), d);
        return c.raw === null ? "" : quote(String(c.raw), d);
      })
      .join(d) + "\r\n"
  );
}

/** Rândul de antet (coduri de coloană stabile, ASCII). */
export function csvHeader(columns: readonly string[], dialect: CsvDialect = "rfc4180"): string {
  return csvRow(
    columns.map((c) => raw(c)),
    dialect,
  );
}

/** Suma formatată zecimal, exact (bigint → text), cu separatorul zecimal al dialectului. */
export function decimal(m: Money, dialect: CsvDialect = "rfc4180"): CsvCell {
  const s = toDecimalString(m);
  return raw(dialect === "ro" ? s.replace(".", ",") : s);
}
