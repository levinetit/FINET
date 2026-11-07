import "server-only";

import type { Actor } from "@/lib/authz";
import {
  DEFAULT_TIME_ZONE,
  addMonths,
  currentMonth,
  localDateOf,
  monthBounds,
  monthsEndingAt,
} from "@/lib/calendar";
import type { Currency } from "@/lib/money";
import { TRANSACTIONAL_ACCOUNT_TYPES } from "@/db/schema";
import { selectAccounts } from "@/modules/accounts/accounts.repo";
import { computeBalances } from "@/modules/accounts/accounts.service";
import { type PlanningDeps } from "@/modules/budgets/budgets.service";
import { selectHouseholdTimeZone } from "@/modules/budgets/budgets.repo";
import { sortCurrencies } from "@/modules/dashboard/dashboard.service";
import { inHousehold } from "@/modules/ledger/context";
import { parseInput } from "@/modules/ledger/input";
import { selectRules } from "@/modules/recurring/recurring.repo";

import {
  DEFAULT_HORIZON,
  type ForecastHistoryMonth,
  type ForecastRule,
  HISTORY_MONTHS,
  computeForecast,
} from "./forecast";
import { selectMonthlyTotalsBySource } from "./forecast.repo";
import { type ForecastView, forecastQuerySchema } from "./forecast.schema";

/**
 * Prognoza de cash-flow a gospodăriei (ADR 0045), separat pe monedă: „azi” în fusul gospodăriei,
 * soldul conturilor active vizibile actorului, regulile recurente active (vizibile sub RLS) și
 * totalurile ultimelor `HISTORY_MONTHS` luni complete, împărțite în recurent/nerecurent. Calculul e
 * pur (`forecast.ts`). Nicio scriere.
 */

const TRANSACTIONAL = new Set<string>(TRANSACTIONAL_ACCOUNT_TYPES);

export async function getForecast(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown = {},
): Promise<ForecastView> {
  const input = parseInput(forecastQuerySchema, rawInput) ?? {};
  const days = input.days ?? DEFAULT_HORIZON;
  const now = deps.now ?? (() => new Date());
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const tz = (await selectHouseholdTimeZone(tx, m.householdId)) ?? DEFAULT_TIME_ZONE;
    const instant = now();
    const today = localDateOf(instant, tz);
    const lastFull = addMonths(currentMonth(instant, tz), -1);
    const months = monthsEndingAt(lastFull, HISTORY_MONTHS);
    const from = monthBounds(months[0]!).from;
    const to = monthBounds(lastFull).to;

    const accountRows = await selectAccounts(tx, m.householdId, { includeArchived: false });
    const [balances, ruleRows, history] = await Promise.all([
      computeBalances(tx, m.householdId, accountRows),
      selectRules(tx, m.householdId, "active"),
      selectMonthlyTotalsBySource(tx, m.householdId, from, to),
    ]);

    // Doar conturile tranzacționale (cash, bancă, economii, card): o proprietate sau un credit
    // (ADR 0046) nu sunt bani disponibili în următoarele 90 de zile.
    const opening = new Map<Currency, bigint>();
    for (const a of accountRows) {
      if (!TRANSACTIONAL.has(a.type)) continue;
      opening.set(a.currency, (opening.get(a.currency) ?? 0n) + (balances.get(a.id) ?? 0n));
    }
    const currencies = sortCurrencies([
      ...opening.keys(),
      ...ruleRows.map((r) => r.currency),
      ...history.map((h) => h.currency),
    ]);

    const forecasts = currencies.map((currency) => {
      const rules: ForecastRule[] = ruleRows
        .filter((r) => r.currency === currency)
        .map((r) => ({
          id: r.id,
          description: r.description,
          type: r.type,
          amountMinor: r.amountMinor,
          spec: {
            frequency: r.frequency,
            interval: r.interval,
            dayOfMonth: r.dayOfMonth,
            startOn: r.startOn,
          },
          nextRunOn: r.nextRunOn,
          endOn: r.endOn,
          remainingOccurrences:
            r.maxOccurrences === null ? null : Math.max(0, r.maxOccurrences - r.occurrencesCount),
        }));
      const series: ForecastHistoryMonth[] = months.map((month) => {
        const rows = history.filter((h) => h.currency === currency && h.month === month);
        const sum = (recurring: boolean, key: "income" | "expense") =>
          rows
            .filter((h) => h.recurring === recurring)
            .reduce((acc, h) => acc + BigInt(h[key]), 0n);
        const recurringIncome = sum(true, "income");
        const recurringExpense = sum(true, "expense");
        return {
          month,
          incomeMinor: sum(false, "income") + recurringIncome,
          expenseMinor: sum(false, "expense") + recurringExpense,
          recurringIncomeMinor: recurringIncome,
          recurringExpenseMinor: recurringExpense,
        };
      });
      return computeForecast({
        currency,
        today,
        days,
        openingMinor: opening.get(currency) ?? 0n,
        rules,
        history: series,
      });
    });
    return { today, days, currencies: forecasts };
  });
}
