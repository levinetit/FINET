import "server-only";

import type { Actor } from "@/lib/authz";
import {
  DEFAULT_TIME_ZONE,
  addDays,
  currentMonth,
  localDateOf,
  monthBounds,
  monthsEndingAt,
} from "@/lib/calendar";
import { ValidationError } from "@/lib/errors";
import type { Currency } from "@/lib/money";
import { selectHouseholdTimeZone } from "@/modules/budgets/budgets.repo";
import type { PlanningDeps } from "@/modules/budgets/budgets.service";
import { selectMonthlyTotals } from "@/modules/dashboard/dashboard.repo";
import { sortCurrencies } from "@/modules/dashboard/dashboard.service";
import { averageExpense, divRound } from "@/modules/health/health";
import { balancesByCurrency } from "@/modules/health/health.service";
import { inHousehold } from "@/modules/ledger/context";
import { parseInput, resolvePositiveAmount } from "@/modules/ledger/input";

import { goalView } from "./goals.service";
import { selectGoals } from "./goals.repo";
import {
  DAYS_PER_MONTH_X100,
  type EmergencyFundPlan,
  type SavingsPlan,
  type SavingsSimulation,
  emergencyFundPlan,
  monthsToReach,
  savingsPlan,
  savingsSimulateSchema,
} from "./plan";

/**
 * Planul de economisire al gospodăriei (ADR 0047): fiecare obiectiv activ cu rata necesară la
 * termen, plus fondul de urgență pe monedă (din lichidul vizibil și media cheltuielilor ultimelor
 * 3 luni, ca la scor). Simularea nu citește obiective și nu scrie nimic.
 */

export type GoalPlanView = Readonly<{
  goalId: string;
  name: string;
  currency: Currency;
  targetMinor: bigint;
  savedMinor: bigint;
  deadline: string | null;
  accountId: string | null;
  plan: SavingsPlan;
}>;

export type SavingsPlanView = Readonly<{
  today: string;
  goals: readonly GoalPlanView[];
  emergency: readonly EmergencyFundPlan[];
}>;

const HISTORY_MONTHS = 3;

export async function getSavingsPlan(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
): Promise<SavingsPlanView> {
  const now = deps.now ?? (() => new Date());
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const tz = (await selectHouseholdTimeZone(tx, m.householdId)) ?? DEFAULT_TIME_ZONE;
    const instant = now();
    const today = localDateOf(instant, tz);
    const month = currentMonth(instant, tz);
    const months = monthsEndingAt(month, HISTORY_MONTHS);
    const [goalRows, balances, totals] = await Promise.all([
      selectGoals(tx, m.householdId, "active"),
      balancesByCurrency(tx, m.householdId),
      selectMonthlyTotals(tx, m.householdId, monthBounds(months[0]!).from, monthBounds(month).to),
    ]);
    const goals: GoalPlanView[] = goalRows.map((row) => {
      const g = goalView(row);
      return {
        goalId: g.id,
        name: g.name,
        currency: g.currency,
        targetMinor: g.targetMinor,
        savedMinor: g.savedMinor,
        deadline: g.deadline,
        accountId: g.accountId,
        plan: savingsPlan({
          targetMinor: g.targetMinor,
          savedMinor: g.savedMinor,
          deadline: g.deadline,
          today,
        }),
      };
    });
    const currencies = sortCurrencies([...balances.keys(), ...totals.map((t) => t.currency)]);
    const emergency = currencies.map((currency) => {
      const series = months.map((mo) => {
        const r = totals.find((t) => t.currency === currency && t.month === mo);
        return {
          month: mo,
          incomeMinor: r ? BigInt(r.income) : 0n,
          expenseMinor: r ? BigInt(r.expense) : 0n,
        };
      });
      const liquid = balances.get(currency)?.liquidMinor ?? 0n;
      return emergencyFundPlan(currency, averageExpense(series, HISTORY_MONTHS), liquid);
    });
    return { today, goals, emergency };
  });
}

/** Simularea unui plan: pur, dar „azi” vine din fusul gospodăriei (de aceea e în serviciu). */
export async function simulateSavings(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown,
): Promise<SavingsSimulation> {
  const input = parseInput(savingsSimulateSchema, rawInput);
  const now = deps.now ?? (() => new Date());
  const tz = await inHousehold(deps, actor, householdId, (tx, m) =>
    selectHouseholdTimeZone(tx, m.householdId),
  );
  const today = localDateOf(now(), tz ?? DEFAULT_TIME_ZONE);
  const targetMinor = resolvePositiveAmount(
    { amountMinor: input.targetMinor, amount: input.target },
    input.currency,
    "targetMinor",
  );
  const savedMinor = BigInt(input.savedMinor ?? 0);
  if (input.deadline && input.deadline < today) {
    throw new ValidationError({ deadline: "Termenul trebuie să fie azi sau în viitor." });
  }
  const monthlyMinor =
    input.monthlyMinor !== undefined || input.monthly !== undefined
      ? resolvePositiveAmount(
          { amountMinor: input.monthlyMinor, amount: input.monthly },
          input.currency,
          "monthlyMinor",
        )
      : null;
  const remaining = targetMinor - savedMinor;
  const byDeadline = input.deadline
    ? {
        ...savingsPlan({ targetMinor, savedMinor, deadline: input.deadline, today }),
        deadline: input.deadline,
      }
    : null;
  let byMonthly: SavingsSimulation["byMonthly"] = null;
  if (monthlyMinor !== null) {
    const months = monthsToReach(remaining, monthlyMinor);
    const finishOn =
      months === null
        ? null
        : addDays(today, Number(divRound(BigInt(months) * DAYS_PER_MONTH_X100, 100n)));
    byMonthly = { monthlyMinor, months, finishOn };
  }
  return { currency: input.currency, targetMinor, savedMinor, today, byDeadline, byMonthly };
}
