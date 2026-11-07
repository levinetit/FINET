import type { CalendarDate } from "@/lib/calendar";
import type { Currency } from "@/lib/money";
import { divRound } from "@/modules/health/health";

/**
 * Managerul de abonamente (modernizare 2026, pasul I; ADR 0047): o VEDERE peste regulile recurente
 * de cheltuieli (ADR 0011), fără tabelă nouă. Fiecare regulă e un abonament cu costul normalizat
 * lunar și anual (în întregi, rotunjit la cea mai apropiată unitate minoră), următoarea reînnoire
 * (`next_run_on`), categoria și starea; totalurile pe monedă, gruparea pe categorii și
 * reînnoirile din următoarele 30 de zile. „Detectate” = propunerile din istoric (ADR 0019) care
 * nu sunt încă reguli.
 *
 * Normalizare (interval `n`): lunar `suma / n`; anual `suma / (12 n)`; săptămânal
 * `suma × 52 / (12 n)`; zilnic `suma × 365 / (12 n)`. Anual = lunar × 12, în afară de regulile
 * anuale (suma / n) și lunare (suma × 12 / n), calculate exact.
 */

export const RENEWAL_WINDOW_DAYS = 30;

export type SubscriptionRule = Readonly<{
  id: string;
  description: string;
  merchant: string | null;
  categoryId: string | null;
  accountId: string;
  currency: Currency;
  amountMinor: bigint;
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  nextRunOn: CalendarDate;
  endOn: CalendarDate | null;
  status: "active" | "paused" | "completed";
}>;

export type Subscription = Readonly<{
  ruleId: string;
  name: string;
  merchant: string | null;
  categoryId: string | null;
  categoryName: string | null;
  accountId: string;
  currency: Currency;
  amountMinor: bigint;
  frequency: SubscriptionRule["frequency"];
  interval: number;
  monthlyMinor: bigint;
  annualMinor: bigint;
  nextRenewalOn: CalendarDate | null;
  /** Zile până la reînnoire (negativ = scadență restantă), `null` fără reînnoire. */
  daysToRenewal: number | null;
  status: SubscriptionRule["status"];
}>;

export type CategoryTotal = Readonly<{
  categoryId: string | null;
  categoryName: string | null;
  monthlyMinor: bigint;
  count: number;
}>;

export type SubscriptionsSummary = Readonly<{
  currency: Currency;
  activeCount: number;
  pausedCount: number;
  monthlyMinor: bigint;
  annualMinor: bigint;
  byCategory: readonly CategoryTotal[];
  /** Reînnoirile active din următoarele `RENEWAL_WINDOW_DAYS` zile, cronologic. */
  upcoming: readonly Subscription[];
  subscriptions: readonly Subscription[];
}>;

export function monthlyCost(
  amountMinor: bigint,
  frequency: SubscriptionRule["frequency"],
  interval: number,
): bigint {
  const n = BigInt(Math.max(1, interval));
  switch (frequency) {
    case "monthly":
      return divRound(amountMinor, n);
    case "yearly":
      return divRound(amountMinor, 12n * n);
    case "weekly":
      return divRound(amountMinor * 52n, 12n * n);
    case "daily":
      return divRound(amountMinor * 365n, 12n * n);
  }
}

export function annualCost(
  amountMinor: bigint,
  frequency: SubscriptionRule["frequency"],
  interval: number,
): bigint {
  const n = BigInt(Math.max(1, interval));
  switch (frequency) {
    case "monthly":
      return divRound(amountMinor * 12n, n);
    case "yearly":
      return divRound(amountMinor, n);
    case "weekly":
      return divRound(amountMinor * 52n, n);
    case "daily":
      return divRound(amountMinor * 365n, n);
  }
}

const dayNumber = (d: CalendarDate): number =>
  Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

export function toSubscription(
  rule: SubscriptionRule,
  today: CalendarDate,
  names: ReadonlyMap<string, string>,
): Subscription {
  const renews = rule.status === "active" && (rule.endOn === null || rule.nextRunOn <= rule.endOn);
  return {
    ruleId: rule.id,
    name: rule.description,
    merchant: rule.merchant,
    categoryId: rule.categoryId,
    categoryName: rule.categoryId ? (names.get(rule.categoryId) ?? null) : null,
    accountId: rule.accountId,
    currency: rule.currency,
    amountMinor: rule.amountMinor,
    frequency: rule.frequency,
    interval: rule.interval,
    monthlyMinor: monthlyCost(rule.amountMinor, rule.frequency, rule.interval),
    annualMinor: annualCost(rule.amountMinor, rule.frequency, rule.interval),
    nextRenewalOn: renews ? rule.nextRunOn : null,
    daysToRenewal: renews ? dayNumber(rule.nextRunOn) - dayNumber(today) : null,
    status: rule.status,
  };
}

export function summarize(
  currency: Currency,
  rules: readonly SubscriptionRule[],
  today: CalendarDate,
  names: ReadonlyMap<string, string>,
): SubscriptionsSummary {
  const subs = rules
    .filter((r) => r.currency === currency && r.status !== "completed")
    .map((r) => toSubscription(r, today, names))
    .sort(
      (a, b) =>
        (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) ||
        (b.monthlyMinor > a.monthlyMinor ? 1 : b.monthlyMinor < a.monthlyMinor ? -1 : 0) ||
        a.name.localeCompare(b.name, "ro") ||
        a.ruleId.localeCompare(b.ruleId),
    );
  const active = subs.filter((s) => s.status === "active");
  const byCategory = new Map<
    string | null,
    { monthlyMinor: bigint; count: number; name: string | null }
  >();
  for (const s of active) {
    const acc = byCategory.get(s.categoryId) ?? {
      monthlyMinor: 0n,
      count: 0,
      name: s.categoryName,
    };
    acc.monthlyMinor += s.monthlyMinor;
    acc.count += 1;
    byCategory.set(s.categoryId, acc);
  }
  const categories: CategoryTotal[] = [...byCategory.entries()]
    .map(([categoryId, v]) => ({
      categoryId,
      categoryName: v.name,
      monthlyMinor: v.monthlyMinor,
      count: v.count,
    }))
    .sort(
      (a, b) =>
        (b.monthlyMinor > a.monthlyMinor ? 1 : b.monthlyMinor < a.monthlyMinor ? -1 : 0) ||
        (a.categoryName ?? "").localeCompare(b.categoryName ?? "", "ro"),
    );
  const upcoming = active
    .filter((s) => s.daysToRenewal !== null && s.daysToRenewal <= RENEWAL_WINDOW_DAYS)
    .sort((a, b) => a.daysToRenewal! - b.daysToRenewal! || a.name.localeCompare(b.name, "ro"));
  return {
    currency,
    activeCount: active.length,
    pausedCount: subs.length - active.length,
    monthlyMinor: active.reduce((acc, s) => acc + s.monthlyMinor, 0n),
    annualMinor: active.reduce((acc, s) => acc + s.annualMinor, 0n),
    byCategory: categories,
    upcoming,
    subscriptions: subs,
  };
}
