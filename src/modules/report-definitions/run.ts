import { daysInclusive } from "@/lib/periods";
import type { Currency } from "@/lib/money";
import { divRound, divRoundHalfAway, quantityMilli } from "@/modules/prices/units";

import { type LineKindFilter, type ReportRules, matchesName } from "./rules";

/**
 * Rularea unui raport de micro-cheltuieli (Faza 10, F10-B; ADR 0023): funcții PURE peste liniile
 * bonurilor confirmate vizibile. Aritmetică pe `bigint`; moneda nu se amestecă.
 *
 * - **Potrivire**: `matchesName` pe numele normalizat + tipul liniei din regulă (aici, încă o
 *   dată, după filtrul din bază).
 * - **Total**: `charged` = suma liniilor care costă (produs, pungă, garanție, altele), `credit` =
 *   suma reducerilor potrivite, `net = charged − credit`. Titlul raportului (`totalMinor`) e
 *   `net`, iar la rapoartele DOAR de reduceri (`mode = "savings"`) e `credit`.
 * - **Bucăți** = suma cantităților liniilor care costă (cantitate lipsă = 1); **preț mediu pe
 *   unitate** = `charged / bucăți` (rotunjit la ban).
 * - **Proiecția anuală** = `total · 365 / zile acoperite`, unde zilele sunt intervalul dintre
 *   primul și ultimul bon confirmat vizibil din perioadă (TOATE bonurile, nu doar liniile
 *   potrivite: o singură linie potrivită într-o săptămână de bonuri nu se extrapolează). Sub
 *   `PROJECTION_MIN_DAYS` zile sau `PROJECTION_MIN_RECEIPTS` bonuri: „date insuficiente”.
 *   Mereu o ESTIMARE.
 */

export const PROJECTION_MIN_DAYS = 60;
export const PROJECTION_MIN_RECEIPTS = 10;
export const HISTORY_LIMIT = 200;
export const MAX_MONTHS_LISTED = 60;

export type RunLine = Readonly<{
  id: string;
  receiptId: string;
  occurredOn: string;
  currency: Currency;
  kind: LineKindFilter;
  rawName: string;
  normalizedName: string;
  quantity: string | null;
  lineTotalMinor: bigint;
  merchantName: string | null;
}>;

/** Bonurile confirmate vizibile din perioadă (toate, nu doar cele cu linii potrivite). */
export type Coverage = Readonly<{
  firstOn: string | null;
  lastOn: string | null;
  receipts: number;
}>;

export type Projection =
  | Readonly<{ status: "ok"; yearlyMinor: bigint; coverageDays: number; receipts: number }>
  | Readonly<{
      status: "insufficient";
      coverageDays: number;
      receipts: number;
    }>;

export type MonthTotal = Readonly<{ month: string; totalMinor: bigint }>;

export type CurrencyRun = Readonly<{
  currency: Currency;
  mode: "standard" | "savings";
  chargedMinor: bigint;
  creditMinor: bigint;
  netMinor: bigint;
  /** Valoarea din titlu: `net`, iar la rapoartele doar de reduceri `credit`. */
  totalMinor: bigint;
  /** Cantitatea în miimi (bucăți sau unități de vânzare). */
  piecesMilli: bigint;
  avgUnitMinor: bigint | null;
  lineCount: number;
  receiptCount: number;
  projection: Projection;
  byMonth: readonly MonthTotal[];
}>;

export type ReportRun = Readonly<{
  currencies: readonly CurrencyRun[];
  /** Cele mai noi linii potrivite (cel mult `HISTORY_LIMIT`), toate monedele. */
  lines: readonly RunLine[];
  linesTruncated: boolean;
  matchedLines: number;
}>;

export function modeOf(rules: Pick<ReportRules, "kinds">): "standard" | "savings" {
  return rules.kinds.every((k) => k === "discount") ? "savings" : "standard";
}

function projectionOf(total: bigint, coverage: Coverage): Projection {
  if (coverage.firstOn === null || coverage.lastOn === null) {
    return { status: "insufficient", coverageDays: 0, receipts: coverage.receipts };
  }
  const days = daysInclusive(coverage.firstOn, coverage.lastOn);
  if (days < PROJECTION_MIN_DAYS || coverage.receipts < PROJECTION_MIN_RECEIPTS) {
    return { status: "insufficient", coverageDays: days, receipts: coverage.receipts };
  }
  return {
    status: "ok",
    yearlyMinor: divRoundHalfAway(total * 365n, BigInt(days)),
    coverageDays: days,
    receipts: coverage.receipts,
  };
}

/** Liniile care intră în raport: tipul din regulă ȘI potrivirea pe nume (verificate în cod). */
export function matchLines(rules: ReportRules, candidates: readonly RunLine[]): RunLine[] {
  const kinds = new Set<string>(rules.kinds);
  return candidates.filter((l) => kinds.has(l.kind) && matchesName(rules, l.normalizedName));
}

export function runReport(
  rules: ReportRules,
  candidates: readonly RunLine[],
  coverage: Coverage,
): ReportRun {
  const matched = matchLines(rules, candidates);
  const mode = modeOf(rules);
  const currencies = [...new Set(matched.map((l) => l.currency))].sort();
  const runs: CurrencyRun[] = currencies.map((currency) => {
    const mine = matched.filter((l) => l.currency === currency);
    let charged = 0n;
    let credit = 0n;
    let pieces = 0n;
    const monthly = new Map<string, bigint>();
    for (const l of mine) {
      const isCredit = l.kind === "discount";
      if (isCredit) credit += l.lineTotalMinor;
      else {
        charged += l.lineTotalMinor;
        pieces += quantityMilli(l.quantity);
      }
      const month = l.occurredOn.slice(0, 7);
      const signed =
        mode === "savings" ? l.lineTotalMinor : isCredit ? -l.lineTotalMinor : l.lineTotalMinor;
      monthly.set(month, (monthly.get(month) ?? 0n) + signed);
    }
    const net = charged - credit;
    const total = mode === "savings" ? credit : net;
    return {
      currency,
      mode,
      chargedMinor: charged,
      creditMinor: credit,
      netMinor: net,
      totalMinor: total,
      piecesMilli: pieces,
      avgUnitMinor: pieces > 0n && charged > 0n ? divRound(charged * 1000n, pieces) : null,
      lineCount: mine.length,
      receiptCount: new Set(mine.map((l) => l.receiptId)).size,
      projection: projectionOf(total, coverage),
      byMonth: [...monthly.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-MAX_MONTHS_LISTED)
        .map(([month, totalMinor]) => ({ month, totalMinor })),
    };
  });
  const newestFirst = [...matched].sort((a, b) =>
    a.occurredOn !== b.occurredOn
      ? a.occurredOn < b.occurredOn
        ? 1
        : -1
      : a.id.localeCompare(b.id),
  );
  return {
    currencies: runs,
    lines: newestFirst.slice(0, HISTORY_LIMIT),
    linesTruncated: newestFirst.length > HISTORY_LIMIT,
    matchedLines: matched.length,
  };
}
