/**
 * Ajutoarele interfeței plăților recurente (F5-B): descrierea regulii, starea afișată, filtrul
 * listei și validarea formularului. Funcții pure, comune serverului și browserului, fără a importa
 * schema bazei în browser: listele de valori sunt copiate aici și verificate față de cele din
 * `src/db/schema` în `recurring-ui.test.ts`. Limitele sunt ACELEAȘI cu ale serviciului
 * (`recurring.schema.ts`): descriere 1–500, interval 1–100, rate 1–1200, ziua 1–31.
 */

import type { Currency } from "@/lib/money";
import { ro } from "@/messages/ro";
import type { RecurringRuleJson } from "@/modules/recurring/recurring.schema";

import { formatMinor, parseAmountInput } from "./ledger-ui";
import { formatDate } from "./planning-ui";

export const UI_RECURRING_TYPES = ["expense", "income"] as const;
export const UI_RECURRING_FREQUENCIES = ["monthly", "weekly", "daily", "yearly"] as const;
export const UI_RECURRING_STATUSES = ["active", "paused", "completed"] as const;

export const RECURRING_LIMITS = Object.freeze({
  description: 500,
  merchant: 200,
  interval: 100,
  maxOccurrences: 1200,
});

export type RecurringStatusFilter = (typeof UI_RECURRING_STATUSES)[number] | "all";

/** Filtrul din `?status=`: o stare cunoscută sau „toate”. */
export function statusFilterOf(value: string | string[] | undefined): RecurringStatusFilter {
  const v = Array.isArray(value) ? value[0] : value;
  return (UI_RECURRING_STATUSES as readonly string[]).includes(v ?? "")
    ? (v as RecurringStatusFilter)
    : "all";
}

export const usesDayOfMonth = (frequency: string) =>
  frequency === "monthly" || frequency === "yearly";

/**
 * Pusă pe pauză AUTOMAT din cauza contului arhivat (generarea a găsit contul arhivat): starea
 * `paused` și codul `account_archived`. O pauză manuală nu are codul (reluarea îl șterge).
 */
export function isPausedByArchivedAccount(
  rule: Pick<RecurringRuleJson, "status" | "lastErrorCode">,
): boolean {
  return rule.status === "paused" && rule.lastErrorCode === "account_archived";
}

/** Eticheta stării, cu motivul „cont arhivat” când e cazul. */
export function statusLabel(rule: Pick<RecurringRuleJson, "status" | "lastErrorCode">): string {
  if (isPausedByArchivedAccount(rule)) return ro.recurring.pausedArchived;
  return ro.recurring.statuses[rule.status] ?? rule.status;
}

/** „lunar, în ziua 15” / „la fiecare 2 săptămâni”. */
export function scheduleText(
  rule: Pick<RecurringRuleJson, "frequency" | "interval" | "dayOfMonth">,
): string {
  const t = ro.recurring;
  const base = t.every(rule.interval, rule.frequency);
  return rule.dayOfMonth !== null && usesDayOfMonth(rule.frequency)
    ? `${base}, ${t.onDay(rule.dayOfMonth)}`
    : base;
}

/** Linia secundară a unei reguli: suma, calendarul, următoarea scadență (`zz.ll.aaaa`), ratele. */
export function ruleSummary(rule: RecurringRuleJson): string {
  const t = ro.recurring;
  const parts = [
    formatMinor(rule.amountMinor, rule.currency as Currency),
    scheduleText(rule),
    rule.status === "completed" ? t.noNext : t.next(formatDate(rule.nextRunOn)),
  ];
  if (rule.maxOccurrences !== null) {
    parts.push(t.installments(rule.occurrencesCount, rule.maxOccurrences));
  } else {
    parts.push(t.generatedCount(rule.occurrencesCount));
  }
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------------------------
// Formularul
// ---------------------------------------------------------------------------------------------

export type RecurringFormValues = Readonly<{
  description: string;
  merchant: string;
  type: string;
  accountId: string;
  categoryId: string;
  amount: string;
  frequency: string;
  interval: string;
  dayOfMonth: string;
  startOn: string;
  endOn: string;
  maxOccurrences: string;
}>;

export type RecurringFormResult =
  | Readonly<{ ok: true; body: Record<string, unknown> }>
  | Readonly<{ ok: false; fields: Record<string, string> }>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function intIn(raw: string, min: number, max: number): number | null {
  const v = raw.trim();
  if (!/^\d{1,4}$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}

/**
 * Validarea din browser (aceleași reguli ca serverul, mesaje în română) și corpul cererii:
 * `POST` (creare: toate câmpurile) sau `PATCH` (editare: fără `type` și `startOn`, care nu se
 * schimbă; `null` explicit pentru câmpurile golite). Suma se parsează în moneda contului, ca
 * întreg în unități minore (fără float).
 */
export function recurringFormBody(
  v: RecurringFormValues,
  currency: Currency,
  mode: "create" | "edit",
): RecurringFormResult {
  const t = ro.recurring.errors;
  const fields: Record<string, string> = {};
  const description = v.description.trim().replace(/\s+/g, " ");
  if (description.length < 1 || description.length > RECURRING_LIMITS.description) {
    fields.description = t.description;
  }
  const merchant = v.merchant.trim();
  if (merchant.length > RECURRING_LIMITS.merchant) {
    fields.merchant = `Cel mult ${RECURRING_LIMITS.merchant} caractere.`;
  }
  if (!v.accountId) fields.accountId = t.account;
  const amount = parseAmountInput(v.amount, currency, { positive: true });
  if (!amount.ok) fields.amount = amount.message;
  const frequency = (UI_RECURRING_FREQUENCIES as readonly string[]).includes(v.frequency)
    ? v.frequency
    : "monthly";
  const interval = v.interval.trim() === "" ? 1 : intIn(v.interval, 1, RECURRING_LIMITS.interval);
  if (interval === null) fields.interval = t.interval;
  let dayOfMonth: number | null = null;
  if (usesDayOfMonth(frequency) && v.dayOfMonth.trim() !== "") {
    dayOfMonth = intIn(v.dayOfMonth, 1, 31);
    if (dayOfMonth === null) fields.dayOfMonth = t.dayOfMonth;
  }
  if (mode === "create" && !DATE.test(v.startOn)) fields.startOn = t.startOn;
  const endOn = v.endOn.trim();
  if (endOn !== "" && !DATE.test(endOn)) fields.endOn = ro.ledger.errors.invalid;
  else if (endOn !== "" && DATE.test(v.startOn) && endOn < v.startOn) fields.endOn = t.endOn;
  let maxOccurrences: number | null = null;
  if (v.maxOccurrences.trim() !== "") {
    maxOccurrences = intIn(v.maxOccurrences, 1, RECURRING_LIMITS.maxOccurrences);
    if (maxOccurrences === null) fields.maxOccurrences = t.maxOccurrences;
  }
  if (Object.keys(fields).length > 0 || !amount.ok) return { ok: false, fields };

  const common: Record<string, unknown> = {
    accountId: v.accountId,
    categoryId: v.categoryId || null,
    amountMinor: amount.amountMinor,
    description,
    merchant: merchant || null,
    frequency,
    interval,
    endOn: endOn || null,
    maxOccurrences,
  };
  if (mode === "edit") {
    // Editare: ziua se trimite mereu (null = „din data de început” / nu se aplică).
    return { ok: true, body: { ...common, dayOfMonth } };
  }
  const type = (UI_RECURRING_TYPES as readonly string[]).includes(v.type) ? v.type : "expense";
  const body: Record<string, unknown> = { ...common, type, startOn: v.startOn };
  // Creare: fără `null` (implicit ziua din `startOn`), iar `maxOccurrences`/`endOn` lipsă = fără.
  if (dayOfMonth !== null) body.dayOfMonth = dayOfMonth;
  return { ok: true, body };
}
