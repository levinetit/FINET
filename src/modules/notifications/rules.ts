import type { NotificationKind } from "@/db/schema";
import type { CalendarDate, Month } from "@/lib/calendar";
import { type Currency, formatMoney, money } from "@/lib/money";
import { ro } from "@/messages/ro";

/**
 * Regulile notificărilor (modernizare 2026, pasul J; ADR 0048): funcții PURE care transformă
 * datele deja calculate de celelalte module (prognoză, bugete, consilier, plan de economisire,
 * abonamente, rezumatul lunii, documente) în candidați de notificare cu `dedupKey` stabil, ca
 * aceeași situație să nu notifice de două ori. Textele sunt în `ro.notifications`; sumele sunt
 * formatate aici, din întregi.
 */

export const PAYMENT_DUE_DAYS = 3;
export const RENEWAL_DAYS = 3;
export const GOAL_REMINDER_DAYS = 7;
export const MAX_PER_KIND = 5;

export type Candidate = Readonly<{
  kind: NotificationKind;
  dedupKey: string;
  title: string;
  body: string;
  link: string | null;
}>;

const fmt = (minor: bigint, c: Currency) => formatMoney(money(minor, c));
const tpl = (text: string, vars: Readonly<Record<string, string>>) =>
  text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
const t = () => ro.notifications.texts;

/** Plățile programate (scadențele regulilor) din următoarele `PAYMENT_DUE_DAYS` zile. */
export function paymentsDue(
  events: readonly Readonly<{
    date: CalendarDate;
    ruleId: string;
    description: string;
    type: string;
    amountMinor: bigint;
  }>[],
  currency: Currency,
  today: CalendarDate,
  horizonDays = PAYMENT_DUE_DAYS,
): Candidate[] {
  const end = addDaysIso(today, horizonDays);
  return events
    .filter((e) => e.type === "expense" && e.date > today && e.date <= end)
    .slice(0, MAX_PER_KIND)
    .map((e) => ({
      kind: "payment_due",
      dedupKey: `payment_due:${e.ruleId}:${e.date}`,
      title: tpl(t().payment_due.title, { name: e.description }),
      body: tpl(t().payment_due.body, {
        name: e.description,
        amount: fmt(e.amountMinor, currency),
        date: e.date,
      }),
      link: `/recurring/${e.ruleId}`,
    }));
}

/** Bugetele lunii: galben → avertizare, roșu → depășit (o dată pe buget și lună și stare). */
export function budgetAlerts(
  budgets: readonly Readonly<{
    id: string;
    name: string;
    status: "green" | "yellow" | "red";
    spentMinor: bigint;
    amountMinor: bigint;
    currency: Currency;
  }>[],
  month: Month,
): Candidate[] {
  const out: Candidate[] = [];
  for (const b of budgets) {
    if (b.status === "green") continue;
    const kind: NotificationKind = b.status === "red" ? "budget_exceeded" : "budget_warning";
    const vars = {
      name: b.name,
      spent: fmt(b.spentMinor, b.currency),
      amount: fmt(b.amountMinor, b.currency),
    };
    out.push({
      kind,
      dedupKey: `${kind}:${b.id}:${month}`,
      title: tpl(t()[kind].title, vars),
      body: tpl(t()[kind].body, vars),
      link: `/budgets/${b.id}`,
    });
  }
  return out.slice(0, MAX_PER_KIND * 2);
}

/** Tranzacțiile neobișnuite găsite de consilier (o dată pe tranzacție). */
export function unusualSpending(
  unusual: readonly Readonly<{
    transactionId: string;
    merchant: string | null;
    description: string | null;
    amountMinor: bigint;
    explanation: string;
  }>[],
  currency: Currency,
  month: Month,
): Candidate[] {
  return unusual.slice(0, MAX_PER_KIND).map((u) => ({
    kind: "unusual_spending",
    dedupKey: `unusual_spending:${u.transactionId}`,
    title: tpl(t().unusual_spending.title, { amount: fmt(u.amountMinor, currency) }),
    body: u.explanation,
    link: `/advisor?month=${month}`,
  }));
}

/** Obiectivele cu termen în următoarele 7 zile sau depășit, neatinse (o dată pe obiectiv și termen). */
export function goalReminders(
  goals: readonly Readonly<{
    goalId: string;
    name: string;
    currency: Currency;
    deadline: CalendarDate | null;
    plan: { status: string; remainingMinor: bigint; daysLeft: number | null };
  }>[],
): Candidate[] {
  const out: Candidate[] = [];
  for (const g of goals) {
    if (!g.deadline) continue;
    if (g.plan.status === "overdue") {
      out.push({
        kind: "goal_reminder",
        dedupKey: `goal_overdue:${g.goalId}:${g.deadline}`,
        title: tpl(t().goal_overdue.title, { name: g.name }),
        body: tpl(t().goal_overdue.body, {
          name: g.name,
          remaining: fmt(g.plan.remainingMinor, g.currency),
        }),
        link: `/goals/${g.goalId}`,
      });
    } else if (
      g.plan.status === "on_track" &&
      g.plan.daysLeft !== null &&
      g.plan.daysLeft <= GOAL_REMINDER_DAYS
    ) {
      out.push({
        kind: "goal_reminder",
        dedupKey: `goal_soon:${g.goalId}:${g.deadline}`,
        title: tpl(t().goal_soon.title, { name: g.name, days: String(g.plan.daysLeft) }),
        body: tpl(t().goal_soon.body, {
          name: g.name,
          remaining: fmt(g.plan.remainingMinor, g.currency),
          days: String(g.plan.daysLeft),
        }),
        link: `/goals/${g.goalId}`,
      });
    }
  }
  return out.slice(0, MAX_PER_KIND);
}

/** Reînnoirile abonamentelor din următoarele 3 zile (o dată pe regulă și dată). */
export function subscriptionRenewals(
  subs: readonly Readonly<{
    ruleId: string;
    name: string;
    currency: Currency;
    amountMinor: bigint;
    nextRenewalOn: CalendarDate | null;
    daysToRenewal: number | null;
  }>[],
  horizonDays = RENEWAL_DAYS,
): Candidate[] {
  return subs
    .filter(
      (s) =>
        s.nextRenewalOn !== null &&
        s.daysToRenewal !== null &&
        s.daysToRenewal >= 0 &&
        s.daysToRenewal <= horizonDays,
    )
    .slice(0, MAX_PER_KIND)
    .map((s) => ({
      kind: "subscription_renewal",
      dedupKey: `subscription_renewal:${s.ruleId}:${s.nextRenewalOn}`,
      title: tpl(t().subscription_renewal.title, { name: s.name }),
      body: tpl(t().subscription_renewal.body, {
        name: s.name,
        amount: fmt(s.amountMinor, s.currency),
        date: s.nextRenewalOn!,
      }),
      link: "/subscriptions",
    }));
}

/** Rezumatul lunii precedente, în prima zi a lunii (o dată pe lună). */
export function monthlySummary(
  summary: Readonly<{ month: Month; label: string; lines: readonly Readonly<{ text: string }>[] }>,
): Candidate[] {
  const text = summary.lines.map((l) => l.text).join(" ");
  if (text.trim() === "") return [];
  return [
    {
      kind: "monthly_summary",
      dedupKey: `monthly_summary:${summary.month}`,
      title: tpl(t().monthly_summary.title, { label: summary.label }),
      body: text.slice(0, 1900),
      link: `/reports?month=${summary.month}`,
    },
  ];
}

/** Documentele eșuate (bonuri/extrase) din ultima zi: o notificare pe document. */
export function syncFailures(
  failed: readonly Readonly<{ id: string; kind: "receipt" | "statement" }>[],
): Candidate[] {
  return failed.slice(0, MAX_PER_KIND).map((f) => ({
    kind: "sync_failure",
    dedupKey: `sync_failure:${f.kind}:${f.id}`,
    title: t().sync_failure.title,
    body: f.kind === "receipt" ? t().sync_failure.receipt : t().sync_failure.statement,
    link: f.kind === "receipt" ? "/receipts" : "/statements",
  }));
}

/** Filtrarea după preferințe: doar tipurile active, și deloc dacă notificările sunt oprite. */
export function applyPreferences(
  candidates: readonly Candidate[],
  prefs: Readonly<{ inApp: boolean; kinds: readonly string[] }>,
): Candidate[] {
  if (!prefs.inApp) return [];
  const allowed = new Set(prefs.kinds);
  return candidates.filter((c) => allowed.has(c.kind));
}

function addDaysIso(date: CalendarDate, n: number): CalendarDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
