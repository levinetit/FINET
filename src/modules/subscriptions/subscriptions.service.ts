import "server-only";

import type { Actor } from "@/lib/authz";
import { DEFAULT_TIME_ZONE, localDateOf } from "@/lib/calendar";
import type { Currency } from "@/lib/money";
import { selectHouseholdTimeZone } from "@/modules/budgets/budgets.repo";
import type { PlanningDeps } from "@/modules/budgets/budgets.service";
import { categoryNames, sortCurrencies } from "@/modules/dashboard/dashboard.service";
import { inHousehold } from "@/modules/ledger/context";
import { selectRules } from "@/modules/recurring/recurring.repo";
import { listRecurringSuggestions } from "@/modules/recurring/suggestions.service";
import type { RecurringSuggestion } from "@/modules/recurring/suggestions";

import { type SubscriptionRule, type SubscriptionsSummary, summarize } from "./subscriptions";

/**
 * Abonamentele gospodăriei (ADR 0047): regulile recurente de cheltuieli vizibile actorului (sub
 * RLS: regulile pe conturile personale ale altora nu apar), normalizate pe monedă, plus
 * propunerile detectate din istoric (ADR 0019) care încă nu sunt reguli. Nicio scriere.
 */

export type DetectedSubscription = Readonly<{
  signature: string;
  description: string;
  merchant: string | null;
  currency: Currency;
  amountMinor: bigint;
  frequency: RecurringSuggestion["frequency"];
  occurrences: number;
  lastOn: string;
  nextOn: string;
  accountId: string;
  accountName: string;
}>;

export type SubscriptionsView = Readonly<{
  today: string;
  currencies: readonly SubscriptionsSummary[];
  detected: readonly DetectedSubscription[];
}>;

export async function getSubscriptions(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
): Promise<SubscriptionsView> {
  const now = deps.now ?? (() => new Date());
  const base = await inHousehold(deps, actor, householdId, async (tx, m) => {
    const tz = (await selectHouseholdTimeZone(tx, m.householdId)) ?? DEFAULT_TIME_ZONE;
    const today = localDateOf(now(), tz);
    const [rows, names] = await Promise.all([
      selectRules(tx, m.householdId),
      categoryNames(tx, m.householdId),
    ]);
    const rules: SubscriptionRule[] = rows
      .filter((r) => r.type === "expense")
      .map((r) => ({
        id: r.id,
        description: r.description,
        merchant: r.merchant,
        categoryId: r.categoryId,
        accountId: r.accountId,
        currency: r.currency,
        amountMinor: r.amountMinor,
        frequency: r.frequency,
        interval: r.interval,
        nextRunOn: r.nextRunOn,
        endOn: r.endOn,
        status: r.status,
      }));
    const currencies = sortCurrencies(rules.map((r) => r.currency)).map((currency) =>
      summarize(currency, rules, today, names),
    );
    return { today, currencies };
  });
  // Propunerile din istoric (propria tranzacție, ca în /api/v1/recurring/suggestions).
  const suggestions = await listRecurringSuggestions(deps, actor, householdId);
  const detected: DetectedSubscription[] = suggestions
    .filter((s) => s.type === "expense")
    .map((s) => ({
      signature: s.signature,
      description: s.description,
      merchant: s.merchant,
      currency: s.currency as Currency,
      amountMinor: s.amountMinor,
      frequency: s.frequency,
      occurrences: s.occurrences,
      lastOn: s.lastOn,
      nextOn: s.nextOn,
      accountId: s.accountId,
      accountName: s.accountName,
    }));
  return { ...base, detected };
}
