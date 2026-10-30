import type { BudgetStatus } from "@/modules/budgets/budgets.schema";
import { type Currency, formatMoney, money } from "@/lib/money";
import { monthLabel } from "@/modules/ask/parse";
import type { MonthlyReport, ReportCurrency } from "@/modules/reports/reports.schema";

/**
 * Rezumatul lunii (Faza 10, F10-C partea 2; ADR 0025): câteva propoziții despre o lună, construite
 * ÎN COD din cifrele agregate ale raportului lunar (aceleași ca pe `/reports`) și din luna
 * precedentă. Nu apelează niciun model și nu trimite nimic în afara aplicației: fiecare cifră din
 * text e inserată din baza de date, nu scrisă de un model. Etichetat clar „Rezumat automat, nu
 * sfat financiar”. Funcții pure.
 */

export const SUMMARY_LABEL = "Rezumat automat, nu sfat financiar.";

export type SummaryLine = Readonly<{
  /** Cod stabil al propoziției (pentru teste și pentru stilizare). */
  code: "empty" | "totals" | "change" | "top_categories" | "top_merchant" | "budgets";
  currency: Currency | null;
  text: string;
}>;

export type MonthlySummary = Readonly<{
  month: string;
  label: string;
  lines: readonly SummaryLine[];
}>;

const fmt = (minor: bigint, currency: Currency) => formatMoney(money(minor, currency));
const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** Variația procentuală rotunjită (jumătățile în sus în valoare absolută), pe bigint. */
export function percentChange(current: bigint, previous: bigint): number | null {
  if (previous <= 0n) return null;
  const diff = (current - previous) * 100n;
  const sign = diff < 0n ? -1n : 1n;
  const abs = diff * sign;
  let q = abs / previous;
  if ((abs % previous) * 2n >= previous) q += 1n;
  return Number(sign * q);
}

function budgetName(b: BudgetStatus, names: ReadonlyMap<string, string>): string {
  return b.categoryId ? (names.get(b.categoryId) ?? "Categorie") : "Toate categoriile";
}

export function buildSummary(
  current: MonthlyReport,
  previous: MonthlyReport | null,
  categoryNames: ReadonlyMap<string, string>,
): MonthlySummary {
  const label = monthLabel(current.month);
  const prevLabel = previous ? monthLabel(previous.month) : null;
  const lines: SummaryLine[] = [];

  if (current.currencies.length === 0) {
    lines.push({
      code: "empty",
      currency: null,
      text: `Nu ai tranzacții înregistrate în ${label}.`,
    });
  }
  for (const c of current.currencies) {
    const cur = c.currency;
    const t = c.totals;
    const net =
      t.netMinor >= 0n
        ? `ai rămas cu ${fmt(t.netMinor, cur)} în plus`
        : `ai cheltuit cu ${fmt(-t.netMinor, cur)} mai mult decât ai încasat`;
    lines.push({
      code: "totals",
      currency: cur,
      text: `În ${label} (${cur}): ai cheltuit ${fmt(t.expenseMinor, cur)} și ai încasat ${fmt(t.incomeMinor, cur)}, deci ${net} (${plural(t.transactionCount, "tranzacție", "tranzacții")}).`,
    });
    const before: ReportCurrency | undefined = previous?.currencies.find((p) => p.currency === cur);
    if (before && prevLabel) {
      const pct = percentChange(t.expenseMinor, before.totals.expenseMinor);
      if (pct !== null) {
        const how =
          pct === 0 ? "neschimbate" : pct > 0 ? `cu ${pct}% mai mari` : `cu ${-pct}% mai mici`;
        lines.push({
          code: "change",
          currency: cur,
          text: `Cheltuielile în ${cur} sunt ${how} față de ${prevLabel} (${fmt(before.totals.expenseMinor, cur)} → ${fmt(t.expenseMinor, cur)}).`,
        });
      }
    }
    const top = c.byCategory.slice(0, 3);
    if (top.length > 0) {
      lines.push({
        code: "top_categories",
        currency: cur,
        text: `Cele mai mari cheltuieli pe categorii în ${cur}: ${top
          .map((x) => `${x.name ?? "Fără categorie"} ${fmt(x.amountMinor, cur)} (${x.percent}%)`)
          .join("; ")}.`,
      });
    }
    const merchant = c.topMerchants[0];
    if (merchant) {
      lines.push({
        code: "top_merchant",
        currency: cur,
        text: `Comerciantul cu cele mai mari cheltuieli în ${cur}: ${merchant.merchant} (${fmt(merchant.amountMinor, cur)}, ${plural(merchant.count, "tranzacție", "tranzacții")}).`,
      });
    }
  }

  if (current.budgets.length > 0) {
    const red = current.budgets.filter((b) => b.status === "red");
    const yellow = current.budgets.filter((b) => b.status === "yellow");
    const parts: string[] = [];
    if (red.length > 0) {
      parts.push(`depășite: ${red.map((b) => budgetName(b, categoryNames)).join(", ")}`);
    }
    if (yellow.length > 0) {
      parts.push(
        `aproape de limită: ${yellow.map((b) => budgetName(b, categoryNames)).join(", ")}`,
      );
    }
    lines.push({
      code: "budgets",
      currency: null,
      text:
        parts.length === 0
          ? `Toate cele ${plural(current.budgets.length, "buget", "bugete")} sunt în limită în ${label}.`
          : `Bugete ${parts.join("; ")}.`,
    });
  }
  return { month: current.month, label: SUMMARY_LABEL, lines };
}
