import { createHash } from "node:crypto";

import { type CalendarDate, addDays, addYears, dayNumber, gridDate } from "@/lib/calendar";
import { merchantTokens } from "@/modules/matching/score";

/**
 * Detectarea plăților recurente din istoric (Faza 7, F7-B; ADR 0019): funcție PURĂ, deterministă,
 * în întregi (fără float pe sume, fără AI). Propunerile NU creează nimic: utilizatorul le acceptă
 * (devin reguli de recurență, Faza 5) sau le respinge (se memorează doar amprenta).
 *
 * - Grupare: (cont, tip, monedă, comerciantul normalizat = primele 3 cuvinte semnificative din
 *   `merchant`, altfel din descriere). Mai multe tranzacții în aceeași zi din grup contează o dată.
 * - Periodicitate (ultimele cel mult 6 apariții, TOATE intervalele în fereastră): săptămânal 6–8
 *   zile, lunar 27–34 zile, anual 358–372 de zile. Minimum 3 apariții (săptămânal, lunar), 2 (anual).
 * - Suma: fiecare apariție la cel mult ±10% (1000 de puncte de bază) de mediana ferestrei; suma
 *   propusă = ultima.
 * - Activă: ultima apariție nu e mai veche de 1,5 perioade (12 / 45 / 400 de zile).
 * - Exclusă: o regulă existentă pe același cont, tip, monedă și periodicitate, cu același
 *   comerciant normalizat sau cu suma în toleranță; o propunere respinsă (amprenta).
 */

export type HistoryTx = Readonly<{
  accountId: string;
  type: "income" | "expense";
  currency: string;
  amountMinor: bigint;
  occurredOn: CalendarDate;
  description: string | null;
  merchant: string | null;
  categoryId: string | null;
}>;

export type ExistingRule = Readonly<{
  accountId: string;
  type: "income" | "expense";
  currency: string;
  amountMinor: bigint;
  frequency: string;
  description: string;
  merchant: string | null;
}>;

export type SuggestedFrequency = "weekly" | "monthly" | "yearly";

export type RecurringSuggestion = Readonly<{
  signature: string;
  accountId: string;
  type: "income" | "expense";
  currency: string;
  description: string;
  merchant: string | null;
  categoryId: string | null;
  frequency: SuggestedFrequency;
  amountMinor: bigint;
  occurrences: number;
  lastOn: CalendarDate;
  nextOn: CalendarDate;
}>;

export const AMOUNT_TOLERANCE_BP = 1000n;
const WINDOW = 6;
const PATTERNS: ReadonlyArray<{
  frequency: SuggestedFrequency;
  min: number;
  max: number;
  minCount: number;
  maxAge: number;
}> = [
  { frequency: "weekly", min: 6, max: 8, minCount: 3, maxAge: 12 },
  { frequency: "monthly", min: 27, max: 34, minCount: 3, maxAge: 45 },
  { frequency: "yearly", min: 358, max: 372, minCount: 2, maxAge: 400 },
];

export const SUGGESTION_VERSION = "v1";

export function merchantKey(merchant: string | null, description: string | null): string | null {
  const tokens = merchantTokens(merchant ?? "").length
    ? merchantTokens(merchant)
    : merchantTokens(description);
  return tokens.length ? tokens.slice(0, 3).join(" ") : null;
}

export function suggestionSignature(
  accountId: string,
  type: string,
  currency: string,
  key: string,
  frequency: string,
): string {
  return createHash("sha256")
    .update([SUGGESTION_VERSION, accountId, type, currency, key, frequency].join("|"), "utf8")
    .digest("hex");
}

const within = (a: bigint, ref: bigint) => {
  const d = a > ref ? a - ref : ref - a;
  return d * 10000n <= AMOUNT_TOLERANCE_BP * ref;
};

function median(values: readonly bigint[]): bigint {
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor((s.length - 1) / 2)]!;
}

function nextDate(
  frequency: SuggestedFrequency,
  last: CalendarDate,
  today: CalendarDate,
): CalendarDate {
  const step = (n: number): CalendarDate =>
    frequency === "weekly"
      ? addDays(last, 7 * n)
      : frequency === "monthly"
        ? gridDate(
            {
              frequency: "monthly",
              interval: 1,
              dayOfMonth: Number(last.slice(8, 10)),
              startOn: last,
            },
            n,
          )
        : addYears(last, n);
  let n = 1;
  let d = step(n);
  while (d < today && n < 1000) d = step(++n);
  return d;
}

export function detectRecurring(
  history: readonly HistoryTx[],
  rules: readonly ExistingRule[],
  today: CalendarDate,
  dismissed: ReadonlySet<string> = new Set(),
): RecurringSuggestion[] {
  const groups = new Map<string, { key: string; txs: HistoryTx[] }>();
  for (const t of history) {
    const key = merchantKey(t.merchant, t.description);
    if (!key || t.amountMinor <= 0n) continue;
    const g = `${t.accountId}|${t.type}|${t.currency}|${key}`;
    const entry = groups.get(g) ?? { key, txs: [] };
    entry.txs.push(t);
    groups.set(g, entry);
  }
  const out: RecurringSuggestion[] = [];
  for (const { key, txs } of groups.values()) {
    // Cronologic; o singură apariție pe zi (ultima din zi).
    const byDay = new Map<string, HistoryTx>();
    for (const t of [...txs].sort((a, b) =>
      a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : 0,
    )) {
      byDay.set(t.occurredOn, t);
    }
    const series = [...byDay.values()];
    const last = series[series.length - 1]!;
    for (const p of PATTERNS) {
      const win = series.slice(-WINDOW);
      if (win.length < p.minCount) continue;
      let ok = true;
      for (let i = 1; i < win.length && ok; i++) {
        const gap = dayNumber(win[i]!.occurredOn) - dayNumber(win[i - 1]!.occurredOn);
        if (gap < p.min || gap > p.max) ok = false;
      }
      if (!ok) continue;
      if (dayNumber(today) - dayNumber(last.occurredOn) > p.maxAge) continue;
      const med = median(win.map((t) => t.amountMinor));
      if (!win.every((t) => within(t.amountMinor, med))) continue;
      const covered = rules.some(
        (r) =>
          r.accountId === last.accountId &&
          r.type === last.type &&
          r.currency === last.currency &&
          r.frequency === p.frequency &&
          (merchantKey(r.merchant, r.description) === key || within(r.amountMinor, med)),
      );
      if (covered) break;
      const signature = suggestionSignature(
        last.accountId,
        last.type,
        last.currency,
        key,
        p.frequency,
      );
      if (dismissed.has(signature)) break;
      out.push({
        signature,
        accountId: last.accountId,
        type: last.type,
        currency: last.currency,
        description: (last.description ?? last.merchant ?? key).slice(0, 200) || key,
        merchant: last.merchant ? last.merchant.slice(0, 200) : null,
        categoryId: last.categoryId,
        frequency: p.frequency,
        amountMinor: last.amountMinor,
        occurrences: win.length,
        lastOn: last.occurredOn,
        nextOn: nextDate(p.frequency, last.occurredOn, today),
      });
      break;
    }
  }
  return out.sort((a, b) => b.occurrences - a.occurrences || (a.signature < b.signature ? -1 : 1));
}
