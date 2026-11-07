import "server-only";

import type { Tx } from "@/db";
import type { Actor } from "@/lib/authz";
import { type Month, monthBounds, monthsEndingAt } from "@/lib/calendar";
import type { Currency } from "@/lib/money";
import { selectAccounts } from "@/modules/accounts/accounts.repo";
import { computeBalances } from "@/modules/accounts/accounts.service";
import {
  type PlanningDeps,
  budgetStatusesIn,
  resolveMonth,
} from "@/modules/budgets/budgets.service";
import { selectMonthlyTotals } from "@/modules/dashboard/dashboard.repo";
import { sortCurrencies } from "@/modules/dashboard/dashboard.service";
import { inHousehold } from "@/modules/ledger/context";
import { parseInput } from "@/modules/ledger/input";

import { HEALTH_MONTHS, type HealthInputs, type HealthMonth, computeHealth } from "./health";
import { type HealthView, healthQuerySchema } from "./health.schema";

/**
 * Scorul de sănătate financiară al unei gospodării pentru o lună (ADR 0045), SEPARAT pe monedă
 * (fără conversie, ca dashboard-ul). Citirile rulează în `inHousehold` (apartenența + RLS):
 * totalurile lunare ale ultimelor 6 luni (`selectMonthlyTotals`, un singur query), soldurile
 * conturilor active vizibile actorului (conturile personale ale altora sunt invizibile sub RLS)
 * și stările bugetelor vizibile. Calculul e pur (`health.ts`).
 */

const LIQUID_TYPES = new Set(["cash", "bank", "savings"]);

export type HealthBalances = Readonly<{ liquidMinor: bigint; debtMinor: bigint }>;

/** Soldurile pozitive ale conturilor lichide și datoria (soldurile negative), pe monedă. */
export async function balancesByCurrency(
  tx: Tx,
  householdId: string,
): Promise<Map<Currency, HealthBalances>> {
  const rows = await selectAccounts(tx, householdId, { includeArchived: false });
  const balances = await computeBalances(tx, householdId, rows);
  const out = new Map<Currency, { liquidMinor: bigint; debtMinor: bigint }>();
  for (const row of rows) {
    const balance = balances.get(row.id) ?? 0n;
    const acc = out.get(row.currency) ?? { liquidMinor: 0n, debtMinor: 0n };
    if (balance < 0n) {
      // Card de credit folosit sau descoperit de cont: datorie pe termen scurt.
      acc.debtMinor += -balance;
    } else if (LIQUID_TYPES.has(row.type)) {
      acc.liquidMinor += balance;
    }
    out.set(row.currency, acc);
  }
  return out;
}

export async function getHealthScore(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown = {},
): Promise<HealthView> {
  const input = parseInput(healthQuerySchema, rawInput) ?? {};
  const now = deps.now ?? (() => new Date());
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const month: Month = await resolveMonth(tx, m.householdId, input.month, now);
    const months = monthsEndingAt(month, HEALTH_MONTHS);
    const from = monthBounds(months[0]!).from;
    const to = monthBounds(month).to;
    const [rows, balances, budgets] = await Promise.all([
      selectMonthlyTotals(tx, m.householdId, from, to),
      balancesByCurrency(tx, m.householdId),
      budgetStatusesIn(tx, m.householdId, actor.userId, month),
    ]);
    const currencies = sortCurrencies([
      ...rows.map((r) => r.currency),
      ...balances.keys(),
      ...budgets.map((b) => b.currency),
    ]);
    const scores = currencies.map((currency) => {
      const series: HealthMonth[] = months.map((mo) => {
        const r = rows.find((x) => x.currency === currency && x.month === mo);
        return {
          month: mo,
          incomeMinor: r ? BigInt(r.income) : 0n,
          expenseMinor: r ? BigInt(r.expense) : 0n,
        };
      });
      const b = balances.get(currency) ?? { liquidMinor: 0n, debtMinor: 0n };
      const inputs: HealthInputs = {
        currency,
        month,
        months: series,
        liquidMinor: b.liquidMinor,
        debtMinor: b.debtMinor,
        budgets: budgets.filter((x) => x.currency === currency).map((x) => ({ status: x.status })),
      };
      return computeHealth(inputs);
    });
    return { month, currencies: scores };
  });
}
