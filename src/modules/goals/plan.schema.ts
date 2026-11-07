import { type Currency, money, toJson } from "@/lib/money";

import type { EmergencyFundPlan, SavingsPlan, SavingsSimulation } from "./plan";
import type { GoalPlanView, SavingsPlanView } from "./plan.service";

/** Forma JSON a planului de economisire (ADR 0047). */

const j = (v: bigint, c: Currency) => toJson(money(v, c)).amountMinor;
const jn = (v: bigint | null, c: Currency) => (v === null ? null : j(v, c));

export function planToJson(p: SavingsPlan, c: Currency) {
  return {
    remainingMinor: j(p.remainingMinor, c),
    daysLeft: p.daysLeft,
    dailyMinor: jn(p.dailyMinor, c),
    weeklyMinor: jn(p.weeklyMinor, c),
    monthlyMinor: jn(p.monthlyMinor, c),
    status: p.status,
  };
}

export type PlanJson = ReturnType<typeof planToJson>;

export function goalPlanToJson(g: GoalPlanView) {
  return {
    goalId: g.goalId,
    name: g.name,
    currency: g.currency,
    targetMinor: j(g.targetMinor, g.currency),
    savedMinor: j(g.savedMinor, g.currency),
    deadline: g.deadline,
    accountId: g.accountId,
    plan: planToJson(g.plan, g.currency),
  };
}

export type GoalPlanJson = ReturnType<typeof goalPlanToJson>;

export function emergencyToJson(e: EmergencyFundPlan) {
  const c = e.currency;
  return {
    currency: c,
    averageExpenseMinor: jn(e.averageExpenseMinor, c),
    liquidMinor: j(e.liquidMinor, c),
    options: e.options.map((o) => ({
      months: o.months,
      targetMinor: j(o.targetMinor, c),
      gapMinor: j(o.gapMinor, c),
      monthlyMinor: j(o.monthlyMinor, c),
      coveredX100: o.coveredX100,
      // Procentul din ținta opțiunii acoperit azi (0–100), pentru bare; întreg.
      coveredPct: Math.min(100, Math.floor(o.coveredX100 / o.months)),
    })),
  };
}

export type EmergencyJson = ReturnType<typeof emergencyToJson>;

export function savingsPlanViewToJson(v: SavingsPlanView) {
  return {
    today: v.today,
    goals: v.goals.map(goalPlanToJson),
    emergency: v.emergency.map(emergencyToJson),
  };
}

export type SavingsPlanViewJson = ReturnType<typeof savingsPlanViewToJson>;

export function savingsSimulationToJson(s: SavingsSimulation) {
  const c = s.currency;
  return {
    currency: c,
    targetMinor: j(s.targetMinor, c),
    savedMinor: j(s.savedMinor, c),
    today: s.today,
    byDeadline: s.byDeadline
      ? { ...planToJson(s.byDeadline, c), deadline: s.byDeadline.deadline }
      : null,
    byMonthly: s.byMonthly
      ? {
          monthlyMinor: j(s.byMonthly.monthlyMinor, c),
          months: s.byMonthly.months,
          finishOn: s.byMonthly.finishOn,
        }
      : null,
  };
}

export type SavingsSimulationJson = ReturnType<typeof savingsSimulationToJson>;
