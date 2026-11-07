import { FX_BASE, FX_MICRO } from "@/db/schema/fx";

import {
  type Currency,
  CurrencyMismatchError,
  MINOR_UNIT_DIGITS,
  type Money,
  UnsupportedCurrencyError,
  isCurrency,
  money,
} from "./money";

/**
 * Conversia valutară DOAR pentru afișare (modernizare 2026, pasul K; ADR 0049): cursurile BCE au
 * baza EUR (`rateMicro` = unități din monedă pentru 1 EUR × 1.000.000, întreg). Orice conversie
 * trece prin EUR, în `bigint`, cu rotunjire la cea mai apropiată unitate minoră (jumătățile departe
 * de zero). Nicio sumă convertită nu se stochează; rezultatul e etichetat „≈” și poartă data
 * cursului. Fără curs pentru una dintre monede, conversia e `null` (nu se ghicește).
 */

export { FX_BASE, FX_MICRO };

/** Cursurile unei zile: monedă → `rateMicro`; EUR are mereu `FX_MICRO`. */
export type RateTable = Readonly<{
  date: string;
  rates: ReadonlyMap<Currency, bigint>;
}>;

export function rateOf(table: RateTable, currency: Currency): bigint | null {
  if (currency === FX_BASE) return FX_MICRO;
  const r = table.rates.get(currency);
  return r === undefined || r <= 0n ? null : r;
}

function pow10(n: number): bigint {
  let r = 1n;
  for (let i = 0; i < n; i++) r *= 10n;
  return r;
}

/** Împărțire cu rotunjire la cel mai apropiat întreg, jumătățile departe de zero. */
export function divRoundHalfAway(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new RangeError("împărțire la zero");
  const negative = num < 0n !== den < 0n && num !== 0n;
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  let q = a / b;
  if ((a % b) * 2n >= b) q += 1n;
  return negative ? -q : q;
}

/**
 * `amount` din moneda lui în `to`: valoare_to = amount × rate_to × 10^d_to / (rate_from × 10^d_from).
 * `null` dacă lipsește cursul uneia dintre monede.
 */
export function convert(amount: Money, to: Currency, table: RateTable): Money | null {
  if (!isCurrency(to)) throw new UnsupportedCurrencyError(to);
  if (amount.currency === to) return amount;
  const rateFrom = rateOf(table, amount.currency);
  const rateTo = rateOf(table, to);
  if (rateFrom === null || rateTo === null) return null;
  const num = amount.amountMinor * rateTo * pow10(MINOR_UNIT_DIGITS[to]);
  const den = rateFrom * pow10(MINOR_UNIT_DIGITS[amount.currency]);
  return money(divRoundHalfAway(num, den), to);
}

export type ApproxTotal = Readonly<{
  currency: Currency;
  amountMinor: bigint;
  rateDate: string;
  /** Monedele care au putut fi convertite (în ordinea primirii). */
  converted: readonly Currency[];
  /** Monedele fără curs (rămân în afara totalului). */
  missing: readonly Currency[];
}>;

/**
 * Totalul aproximativ al mai multor sume (în monede diferite) în `base`. Sumele în `base` intră
 * exact; celelalte prin curs. `null` dacă nu există nicio sumă sau dacă toate sunt în `base`
 * (atunci nu e nimic de aproximat).
 */
export function approxTotal(
  amounts: readonly Money[],
  base: Currency,
  table: RateTable,
): ApproxTotal | null {
  if (amounts.length === 0) return null;
  const foreign = amounts.filter((a) => a.currency !== base);
  if (foreign.length === 0) return null;
  let total = 0n;
  const converted: Currency[] = [];
  const missing: Currency[] = [];
  for (const a of amounts) {
    const c = convert(a, base, table);
    if (c === null) {
      if (!missing.includes(a.currency)) missing.push(a.currency);
      continue;
    }
    if (c.currency !== base) throw new CurrencyMismatchError(c.currency, base);
    total += c.amountMinor;
    if (a.currency !== base && !converted.includes(a.currency)) converted.push(a.currency);
  }
  if (converted.length === 0) return null;
  return { currency: base, amountMinor: total, rateDate: table.date, converted, missing };
}

/** Cursul direct între două monede, ca text cu 4 zecimale (pentru afișare: „1 EUR = 4,97 RON”). */
export function crossRateText(from: Currency, to: Currency, table: RateTable): string | null {
  const rf = rateOf(table, from);
  const rt = rateOf(table, to);
  if (rf === null || rt === null) return null;
  // 1 from = rt / rf to, cu 4 zecimale.
  const x = divRoundHalfAway(rt * 10_000n, rf);
  const whole = x / 10_000n;
  const frac = (x % 10_000n).toString().padStart(4, "0");
  return `${whole},${frac}`;
}
