import { z } from "zod";

import { type Currency, money, toJson } from "@/lib/money";
import {
  type BudgetStatus,
  budgetStatusToJson,
  monthSchema,
} from "@/modules/budgets/budgets.schema";
import type { Totals } from "@/modules/dashboard/dashboard.schema";
import { type GoalView, goalToJson } from "@/modules/goals/goals.schema";

/** Raportul lunar (Faza 3): structura de date; formatul (PDF/Excel) vine în Faza 10. */

export const TOP_MERCHANTS = 10;

export const monthlyReportQuerySchema = z
  .strictObject({ month: monthSchema.optional() })
  .optional();

export type ReportCategory = Readonly<{
  /** Categoria-părinte; `null` = fără categorie. */
  categoryId: string | null;
  name: string | null;
  amountMinor: bigint;
  count: number;
  percent: number;
  /** Defalcarea pe subcategorii (inclusiv părintele însuși, dacă are cheltuieli directe). */
  children: ReadonlyArray<
    Readonly<{ categoryId: string | null; name: string | null; amountMinor: bigint; count: number }>
  >;
}>;

export type ReportMerchant = Readonly<{ merchant: string; amountMinor: bigint; count: number }>;

export type ReportCurrency = Readonly<{
  currency: Currency;
  totals: Totals;
  byCategory: ReportCategory[];
  topMerchants: ReportMerchant[];
}>;

export type MonthlyReport = Readonly<{
  month: string;
  currencies: ReportCurrency[];
  /** Bugetele active vizibile actorului, cu starea în lună (bugetele lor au moneda lor). */
  budgets: BudgetStatus[];
  /** Obiectivele active și atinse (fără cele abandonate), cu progresul curent. */
  goals: GoalView[];
}>;

const j = (v: bigint, c: Currency) => toJson(money(v, c)).amountMinor;

export function monthlyReportToJson(r: MonthlyReport) {
  return {
    month: r.month,
    currencies: r.currencies.map((c) => ({
      currency: c.currency,
      totals: {
        incomeMinor: j(c.totals.incomeMinor, c.currency),
        expenseMinor: j(c.totals.expenseMinor, c.currency),
        netMinor: j(c.totals.netMinor, c.currency),
        transactionCount: c.totals.transactionCount,
      },
      byCategory: c.byCategory.map((x) => ({
        ...x,
        amountMinor: j(x.amountMinor, c.currency),
        children: x.children.map((y) => ({ ...y, amountMinor: j(y.amountMinor, c.currency) })),
      })),
      topMerchants: c.topMerchants.map((m) => ({
        ...m,
        amountMinor: j(m.amountMinor, c.currency),
      })),
    })),
    budgets: r.budgets.map(budgetStatusToJson),
    goals: r.goals.map(goalToJson),
  };
}
