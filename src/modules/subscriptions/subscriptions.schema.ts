import { type Currency, money, toJson } from "@/lib/money";

import type { Subscription, SubscriptionsSummary } from "./subscriptions";
import type { DetectedSubscription, SubscriptionsView } from "./subscriptions.service";

/** Forma JSON a abonamentelor (ADR 0047). */

const j = (v: bigint, c: Currency) => toJson(money(v, c)).amountMinor;

export function subscriptionToJson(s: Subscription) {
  const c = s.currency;
  return {
    ruleId: s.ruleId,
    name: s.name,
    merchant: s.merchant,
    categoryId: s.categoryId,
    categoryName: s.categoryName,
    accountId: s.accountId,
    currency: c,
    amountMinor: j(s.amountMinor, c),
    frequency: s.frequency,
    interval: s.interval,
    monthlyMinor: j(s.monthlyMinor, c),
    annualMinor: j(s.annualMinor, c),
    nextRenewalOn: s.nextRenewalOn,
    daysToRenewal: s.daysToRenewal,
    status: s.status,
  };
}

export type SubscriptionJson = ReturnType<typeof subscriptionToJson>;

export function summaryToJson(s: SubscriptionsSummary) {
  const c = s.currency;
  return {
    currency: c,
    activeCount: s.activeCount,
    pausedCount: s.pausedCount,
    monthlyMinor: j(s.monthlyMinor, c),
    annualMinor: j(s.annualMinor, c),
    byCategory: s.byCategory.map((x) => ({
      categoryId: x.categoryId,
      categoryName: x.categoryName,
      monthlyMinor: j(x.monthlyMinor, c),
      count: x.count,
    })),
    upcoming: s.upcoming.map(subscriptionToJson),
    subscriptions: s.subscriptions.map(subscriptionToJson),
  };
}

export type SubscriptionsSummaryJson = ReturnType<typeof summaryToJson>;

export function detectedToJson(d: DetectedSubscription) {
  return {
    signature: d.signature,
    description: d.description,
    merchant: d.merchant,
    currency: d.currency,
    amountMinor: j(d.amountMinor, d.currency),
    frequency: d.frequency,
    occurrences: d.occurrences,
    lastOn: d.lastOn,
    nextOn: d.nextOn,
    accountId: d.accountId,
    accountName: d.accountName,
  };
}

export function subscriptionsViewToJson(v: SubscriptionsView) {
  return {
    today: v.today,
    currencies: v.currencies.map(summaryToJson),
    detected: v.detected.map(detectedToJson),
  };
}

export type SubscriptionsViewJson = ReturnType<typeof subscriptionsViewToJson>;
