import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import { accounts, budgets, categories, goals, transactions } from "@/db/schema";
import type { Currency } from "@/lib/money";

/**
 * Agregările dashboard-ului și ale raportului lunar (în tranzacția `withMember`, cu RLS și filtru
 * explicit pe gospodărie). DOAR venituri și cheltuieli: transferurile (`type = 'transfer'`) nu sunt
 * nici venit, nici cheltuială (5.1) și nu intră nici în numărul de tranzacții. Sumele vin ca text
 * (`sum(bigint)` = `numeric`) și se convertesc în `bigint` de apelant, separat pe monedă.
 */

const t = transactions;
const entries = (householdId: string) =>
  and(eq(t.householdId, householdId), inArray(t.type, ["income", "expense"]));
const between = (from: string, to: string) =>
  sql`${t.occurredOn} between ${from}::date and ${to}::date`;
const sumOf = (type: "income" | "expense") =>
  sql<string>`coalesce(sum(${t.amountMinor}) filter (where ${t.type} = ${type}), 0)::text`;

export type MonthRow = Readonly<{
  currency: Currency;
  month: string;
  income: string;
  expense: string;
  count: number;
}>;

/** Totalurile pe (monedă, lună `YYYY-MM`) în intervalul de zile dat. */
export async function selectMonthlyTotals(
  tx: Tx,
  householdId: string,
  from: string,
  to: string,
): Promise<MonthRow[]> {
  const month = sql<string>`to_char(${t.occurredOn}, 'YYYY-MM')`;
  const rows = await tx
    .select({
      currency: t.currency,
      month,
      income: sumOf("income"),
      expense: sumOf("expense"),
      count: sql<number>`count(*)::int`,
    })
    .from(t)
    .where(and(entries(householdId), between(from, to)))
    .groupBy(t.currency, month);
  return rows.map((r) => ({ ...r, count: Number(r.count) }));
}

export type DayRow = Readonly<{ currency: Currency; day: string; income: string; expense: string }>;

/** Totalurile pe (monedă, zi) în interval; zilele fără tranzacții lipsesc (le completează apelantul). */
export async function selectDailyTotals(
  tx: Tx,
  householdId: string,
  from: string,
  to: string,
): Promise<DayRow[]> {
  return tx
    .select({
      currency: t.currency,
      day: t.occurredOn,
      income: sumOf("income"),
      expense: sumOf("expense"),
    })
    .from(t)
    .where(and(entries(householdId), between(from, to)))
    .groupBy(t.currency, t.occurredOn);
}

export type CategoryRow = Readonly<{
  currency: Currency;
  /** Categoria-părinte (subcategoriile se agregă la ea) sau `null` = fără categorie. */
  rootCategoryId: string | null;
  categoryId: string | null;
  total: string;
  count: number;
}>;

/** Cheltuielile pe (monedă, părinte, categorie) în interval. */
export async function selectExpenseByCategory(
  tx: Tx,
  householdId: string,
  from: string,
  to: string,
): Promise<CategoryRow[]> {
  const root = sql<string | null>`coalesce(${categories.parentId}, ${t.categoryId})`;
  const rows = await tx
    .select({
      currency: t.currency,
      rootCategoryId: root,
      categoryId: t.categoryId,
      total: sql<string>`sum(${t.amountMinor})::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(t)
    .leftJoin(categories, eq(categories.id, t.categoryId))
    .where(and(eq(t.householdId, householdId), eq(t.type, "expense"), between(from, to)))
    .groupBy(t.currency, root, t.categoryId);
  return rows.map((r) => ({ ...r, count: Number(r.count) }));
}

export type MerchantRow = Readonly<{
  currency: Currency;
  merchant: string;
  total: string;
  count: number;
}>;

/**
 * Cei mai mari comercianți (cheltuieli) pe monedă: grupați după numele normalizat (fără spații la
 * capete, fără majuscule); afișat cu cea mai mică variantă (alfabetic) a numelui, deterministă.
 */
export async function selectTopMerchants(
  tx: Tx,
  householdId: string,
  from: string,
  to: string,
  limit: number,
): Promise<MerchantRow[]> {
  const key = sql`lower(btrim(${t.merchant}))`;
  const rows = await tx.execute<{
    currency: Currency;
    merchant: string;
    total: string;
    count: number;
    rn: number;
  }>(sql`
    select currency, merchant, total, count from (
      select ${t.currency} as currency, min(btrim(${t.merchant})) as merchant,
             sum(${t.amountMinor})::text as total, count(*)::int as count,
             row_number() over (partition by ${t.currency}
                                order by sum(${t.amountMinor}) desc, ${key} asc) as rn
        from ${t}
       where ${t.householdId} = ${householdId} and ${t.type} = 'expense'
         and ${between(from, to)}
         and ${t.merchant} is not null and btrim(${t.merchant}) <> ''
       group by ${t.currency}, ${key}
    ) ranked
    where rn <= ${limit}
    order by currency, rn`);
  return rows.map((r) => ({
    currency: r.currency,
    merchant: r.merchant,
    total: String(r.total),
    count: Number(r.count),
  }));
}

/** Pașii de onboarding: există cel puțin un cont, o tranzacție, un buget activ, un obiectiv? */
export async function selectOnboardingFlags(
  tx: Tx,
  householdId: string,
): Promise<
  Readonly<{ hasAccount: boolean; hasTransaction: boolean; hasBudget: boolean; hasGoal: boolean }>
> {
  const [row] = await tx.execute<{ a: boolean; t: boolean; b: boolean; g: boolean }>(sql`
    select exists (select 1 from ${accounts} where ${accounts.householdId} = ${householdId}) as a,
           exists (select 1 from ${transactions} where ${transactions.householdId} = ${householdId}) as t,
           exists (select 1 from ${budgets} where ${budgets.householdId} = ${householdId}
                     and ${budgets.archivedAt} is null) as b,
           exists (select 1 from ${goals} where ${goals.householdId} = ${householdId}) as g`);
  return {
    hasAccount: Boolean(row?.a),
    hasTransaction: Boolean(row?.t),
    hasBudget: Boolean(row?.b),
    hasGoal: Boolean(row?.g),
  };
}
