import { CURRENCIES, type Currency } from "@/lib/money";

import { STATEMENT_MAX_LINES } from "@/db/schema/statements";

import { assertLineCap } from "../table";
import type { AmountStyle } from "../text";
import { buildDescription, cleanReference, parseStatementAmount } from "../text";
import type { Direction, ParsedLine, TextItem } from "../types";
import { StatementError } from "../types";

/** Monedă din text (`RON`, `LEI`, `EUR`, `USD`); altfel `unsupported_currency`. */
export function currencyFrom(text: string): Currency {
  const t = text.trim().toUpperCase();
  const c = t === "LEI" ? "RON" : t;
  if ((CURRENCIES as readonly string[]).includes(c)) return c as Currency;
  throw new StatementError("unsupported_currency");
}

/** Simbolul/codul monedei din sumele Revolut (`10,00€`, `$3,00`, `5,00 RON`). */
export function currencyFromSymbol(s: string): Currency | null {
  if (s.includes("€") || /\bEUR\b/.test(s)) return "EUR";
  if (s.includes("$") || /\bUSD\b/.test(s)) return "USD";
  if (/\b(RON|lei)\b/i.test(s)) return "RON";
  return null;
}

/** Ultimele 4 caractere ale unui IBAN (indiciu pentru alegerea contului; nimic stocat). */
export function ibanLast4(s: string | undefined): string | null {
  const compact = (s ?? "").replace(/\s+/g, "").toUpperCase();
  return /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(compact) ? compact.slice(-4) : null;
}

/** Un rând în curs de construire (ancora + continuările). */
export type Draft = {
  occurredOn: string | null;
  direction: Direction;
  amountMinor: bigint;
  parts: string[];
  reference: string | null;
  kind: "movement" | "fx";
  fxCurrency: Currency | null;
  fxAmountMinor: bigint | null;
  balanceAfterMinor: bigint | null;
  descX: number;
};

export function amountOf(item: TextItem, style: AmountStyle, currency: Currency): bigint {
  return parseStatementAmount(item.s, style, currency);
}

/**
 * Finalizează rândurile: sumele zero se sar (contorizate), rândurile fără dată sunt corupte,
 * numerotarea e consecutivă. Plafonul de rânduri e verificat aici.
 */
export function finalizeLines(drafts: readonly Draft[]): {
  lines: ParsedLine[];
  zeroCount: number;
} {
  assertLineCap(drafts.length, STATEMENT_MAX_LINES);
  const lines: ParsedLine[] = [];
  let zeroCount = 0;
  for (const d of drafts) {
    if (d.occurredOn === null) throw new StatementError("corrupt_row");
    if (d.amountMinor === 0n) {
      zeroCount++;
      continue;
    }
    if (d.amountMinor < 0n) throw new StatementError("corrupt_row");
    lines.push({
      rowNo: lines.length + 1,
      occurredOn: d.occurredOn,
      direction: d.direction,
      amountMinor: d.amountMinor,
      description: buildDescription(d.parts),
      bankReference: cleanReference(d.reference),
      kind: d.kind,
      fxAmountMinor: d.fxCurrency ? d.fxAmountMinor : null,
      fxCurrency: d.fxCurrency,
      balanceAfterMinor: d.balanceAfterMinor,
    });
  }
  return { lines, zeroCount };
}
