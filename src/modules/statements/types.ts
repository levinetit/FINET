import type { Currency } from "@/lib/money";

/**
 * Tipurile comune ale importului de extrase (ADR 0018). Parserele sunt funcții PURE pe elemente
 * de text poziționale (`TextItem`), obținute dintr-un strat de extracție separat (PDF → items, în
 * procesul copil al workerului) sau construite direct în teste din JSON sintetic.
 */

/** Un fragment de text de pe o pagină: x/y în unități PDF (y crește în sus), `w` = lățimea. */
export type TextItem = Readonly<{ p: number; x: number; y: number; w: number; s: string }>;

export type StatementBank =
  "bt" | "brd" | "raiffeisen" | "revolut" | "ing" | "bcr" | "wise" | "generic";
export type StatementFormat = "pdf" | "csv" | "xlsx";
export type Direction = "debit" | "credit";

export type ParsedLine = Readonly<{
  /** Poziția în extras (1, 2, …), după excluderea rândurilor în așteptare. */
  rowNo: number;
  occurredOn: string;
  direction: Direction;
  amountMinor: bigint;
  description: string;
  bankReference: string | null;
  kind: "movement" | "fx";
  fxAmountMinor: bigint | null;
  fxCurrency: Currency | null;
  /** Soldul după rând, dacă extrasul îl arată (Revolut). */
  balanceAfterMinor: bigint | null;
}>;

/** Soldul declarat la sfârșitul unei zile (BT `SOLD FINAL ZI`, Raiffeisen `Soldul zilei`). */
export type DayBalance = Readonly<{ day: string; closingMinor: bigint }>;

export type ParsedStatement = Readonly<{
  bank: StatementBank;
  format: StatementFormat;
  parserVersion: number;
  currency: Currency;
  periodStart: string | null;
  periodEnd: string | null;
  openingBalanceMinor: bigint | null;
  closingBalanceMinor: bigint | null;
  /** Totalurile declarate (BRD „Total debit / Total credit”, Raiffeisen „Rulaj …”). */
  declaredDebitMinor: bigint | null;
  declaredCreditMinor: bigint | null;
  dayBalances: readonly DayBalance[];
  lines: readonly ParsedLine[];
  /** Tranzacții în așteptare (BT `SUME BLOCATE`): NU se importă, doar se numără. */
  pendingCount: number;
  /** Rânduri cu sumă zero (sărite, cu avertisment). */
  zeroCount: number;
  /** Ultimele 4 caractere ale IBAN-ului din antet (doar indiciu pentru alegerea contului). */
  ibanLast4: string | null;
  warnings: readonly string[];
}>;

/** Coduri de eroare FIXE (fără conținut din fișier). */
export type StatementErrorCode =
  | "unknown_bank"
  | "ambiguous_bank"
  | "unsupported_currency"
  | "header_missing"
  | "invalid_amount"
  | "invalid_date"
  | "corrupt_row"
  | "too_many_lines"
  | "empty_statement"
  | "currency_mismatch"
  | "csv_invalid"
  | "csv_mapping_required"
  | "csv_mapping_invalid"
  | "xlsx_invalid"
  | "xlsx_unsafe"
  | "zip_invalid"
  | "zip_unsafe"
  | "file_too_large"
  | "unsupported_format";

export class StatementError extends Error {
  constructor(readonly code: StatementErrorCode) {
    super("Extrasul nu a putut fi citit.");
    this.name = "StatementError";
  }
}
