import { addYears } from "@/lib/calendar";

import { isValidCui, taxIdDigits } from "./cui";
import type { ExtractedLine, ExtractedReceipt } from "./extraction.schema";
import { type VatRateRow, ratesOn } from "./vat";

/**
 * Verificările bonului ÎN COD (master prompt 3.6, 5.5; ADR 0014) și scorul de încredere. LLM-ul
 * doar citește; aici se decide dacă ce a citit e coerent. Scorul (0–100) se calculează DOAR din
 * aceste verificări, nu din vreo „încredere” raportată de model.
 *
 * Reguli (decizia mea, documentate în ADR 0014):
 * - suma liniilor: produse + garanții SGR + pungi + alte − reduceri = total, EXACT (toleranță 0:
 *   pe bonul fiscal totalul liniei e deja rotunjit, iar totalul e suma lor);
 * - linia: |cantitate × preț unitar − total linie| ≤ 1 ban (rotunjirea la ban a produsului);
 * - garanția SGR: multiplu de 0,50 lei (o garanție per ambalaj), doar pentru RON;
 * - CUI: cifra de control (cu sau fără `RO`);
 * - data: nu în viitor (ziua locală), nu mai veche de 5 ani;
 * - TVA: cotele liniilor trebuie să fie valabile la data bonului (tabelul `vat_rates`); TVA-ul
 *   total, dacă se poate calcula din cote, trebuie să fie apropiat de cel calculat (toleranța:
 *   max(2 bani, 1 ban per linie)); altfel cel mult cota maximă din total.
 * Coduri stabile (UI-ul F6-C le traduce), cu câmpul sau linia vizată.
 */

export const ISSUE_CODES = [
  "extraction_failed",
  "ai_unavailable",
  "budget_exceeded",
  "lines_missing",
  "total_missing",
  "total_mismatch",
  "merchant_missing",
  "tax_id_missing",
  "tax_id_invalid",
  "date_missing",
  "date_in_future",
  "date_too_old",
  "vat_rate_unknown",
  "vat_total_implausible",
  "quantity_invalid",
  "line_amount_mismatch",
  "sgr_amount_invalid",
  "low_confidence",
  "duplicate_receipt",
  "long_receipt_order",
  "long_receipt_mismatch",
  "possible_duplicate_image",
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export type ReceiptIssue = Readonly<{
  code: IssueCode;
  field?: "total" | "merchant" | "taxId" | "date" | "vatTotal" | "lines";
  /** Poziția liniei (1..500), pentru problemele pe linie. */
  line?: number;
}>;

/** Penalizările scorului (decizia mea). O problemă pe linie se contează o dată pe cod. */
const PENALTY: Readonly<Partial<Record<IssueCode, number>>> = {
  extraction_failed: 100,
  ai_unavailable: 100,
  budget_exceeded: 100,
  lines_missing: 40,
  total_missing: 40,
  total_mismatch: 40,
  merchant_missing: 5,
  tax_id_missing: 10,
  tax_id_invalid: 20,
  date_missing: 15,
  date_in_future: 30,
  date_too_old: 20,
  vat_rate_unknown: 10,
  vat_total_implausible: 15,
  quantity_invalid: 10,
  line_amount_mismatch: 10,
  sgr_amount_invalid: 10,
  long_receipt_order: 30,
  long_receipt_mismatch: 30,
};

export const MAX_RECEIPT_AGE_YEARS = 5;
export const SGR_DEPOSIT_MINOR = 50n;
export const MAX_ISSUES = 100;

export type CheckContext = Readonly<{
  /** Ziua locală de azi (`Europe/Bucharest`). */
  today: string;
  vatRates: readonly VatRateRow[];
}>;

export function signedLineTotal(line: ExtractedLine): bigint {
  return line.kind === "discount" ? -line.lineTotalMinor : line.lineTotalMinor;
}

/** Suma liniilor cu semn (reducerile scad). */
export function linesSum(lines: readonly ExtractedLine[]): bigint {
  let s = 0n;
  for (const l of lines) s += signedLineTotal(l);
  return s;
}

/** Cantitatea canonică (`"0.754"`) → miimi (754n). */
function thousandths(quantity: string): bigint {
  const [int, frac = ""] = quantity.split(".");
  return BigInt(int!) * 1000n + BigInt(frac.padEnd(3, "0").slice(0, 3));
}

/** Rotunjire la jumătate în sus pentru numărători nenegativi. */
function roundDiv(n: bigint, d: bigint): bigint {
  return (n * 2n + d) / (2n * d);
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

export function checkReceipt(r: ExtractedReceipt, ctx: CheckContext): ReceiptIssue[] {
  const issues: ReceiptIssue[] = [];
  const push = (issue: ReceiptIssue) => {
    if (issues.length < MAX_ISSUES) issues.push(issue);
  };

  if (r.lines.length === 0) push({ code: "lines_missing", field: "lines" });
  if (r.totalMinor === null) push({ code: "total_missing", field: "total" });
  else if (r.lines.length > 0 && linesSum(r.lines) !== r.totalMinor) {
    push({ code: "total_mismatch", field: "total" });
  }
  if (r.merchantName === null) push({ code: "merchant_missing", field: "merchant" });
  if (r.merchantTaxIdMalformed) push({ code: "tax_id_invalid", field: "taxId" });
  else if (r.merchantTaxId === null) push({ code: "tax_id_missing", field: "taxId" });
  else if (!isValidCui(r.merchantTaxId)) push({ code: "tax_id_invalid", field: "taxId" });

  if (r.occurredOn === null) push({ code: "date_missing", field: "date" });
  else if (r.occurredOn > ctx.today) push({ code: "date_in_future", field: "date" });
  else if (r.occurredOn < addYears(ctx.today, -MAX_RECEIPT_AGE_YEARS)) {
    push({ code: "date_too_old", field: "date" });
  }

  const rates = r.occurredOn === null ? null : ratesOn(ctx.vatRates, r.occurredOn);
  r.lines.forEach((l, i) => {
    const line = i + 1;
    if (l.quantity !== null && thousandths(l.quantity) === 0n) {
      push({ code: "quantity_invalid", line });
    }
    if (l.kind === "product" && l.quantity !== null && l.unitPriceMinor !== null) {
      const expected = roundDiv(thousandths(l.quantity) * l.unitPriceMinor, 1000n);
      if (abs(expected - l.lineTotalMinor) > 1n) push({ code: "line_amount_mismatch", line });
    }
    if (
      l.kind === "deposit_sgr" &&
      r.currency === "RON" &&
      l.lineTotalMinor % SGR_DEPOSIT_MINOR !== 0n
    ) {
      push({ code: "sgr_amount_invalid", line });
    }
    if (rates !== null && l.vatRateBp !== null && !rates.has(l.vatRateBp)) {
      push({ code: "vat_rate_unknown", line });
    }
  });

  if (r.vatTotalMinor !== null && r.totalMinor !== null) {
    const allRated = r.lines.length > 0 && r.lines.every((l) => l.vatRateBp !== null);
    if (r.vatTotalMinor > r.totalMinor) {
      push({ code: "vat_total_implausible", field: "vatTotal" });
    } else if (allRated) {
      // TVA-ul inclus: total × cotă / (100% + cotă), pe fiecare linie, cu semn.
      let expected = 0n;
      for (const l of r.lines) {
        const bp = BigInt(l.vatRateBp!);
        const part = roundDiv(l.lineTotalMinor * bp, 10_000n + bp);
        expected += l.kind === "discount" ? -part : part;
      }
      const tolerance = BigInt(Math.max(2, r.lines.length));
      if (abs(expected - r.vatTotalMinor) > tolerance) {
        push({ code: "vat_total_implausible", field: "vatTotal" });
      }
    } else if (rates !== null && rates.size > 0) {
      const maxBp = BigInt(Math.max(...rates));
      const ceiling = roundDiv(r.totalMinor * maxBp, 10_000n + maxBp) + 2n;
      if (r.vatTotalMinor > ceiling) push({ code: "vat_total_implausible", field: "vatTotal" });
    }
  }
  return issues;
}

/** Scorul de încredere 0..100 din probleme (fiecare cod penalizat o singură dată). */
export function confidenceScore(issues: readonly ReceiptIssue[]): number {
  const seen = new Set<IssueCode>();
  let score = 100;
  for (const i of issues) {
    if (seen.has(i.code)) continue;
    seen.add(i.code);
    score -= PENALTY[i.code] ?? 0;
  }
  return Math.max(0, Math.min(100, score));
}

/**
 * Cheia „același bon fotografiat din nou” (CUI + număr + dată + total): textul canonic, din care
 * pipeline-ul face SHA-256 (coloana `dedup_key`). `null` dacă lipsește vreun element sau CUI-ul
 * nu e valid (o cheie parțială ar uni bonuri diferite).
 */
export function dedupSource(r: ExtractedReceipt): string | null {
  if (r.merchantTaxId === null || !isValidCui(r.merchantTaxId)) return null;
  if (r.receiptNumber === null || r.occurredOn === null || r.totalMinor === null) return null;
  const number = r.receiptNumber
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/^0+(?=\d)/, "");
  if (number === "") return null;
  return [
    taxIdDigits(r.merchantTaxId),
    number,
    r.occurredOn,
    r.currency,
    r.totalMinor.toString(),
  ].join("|");
}
