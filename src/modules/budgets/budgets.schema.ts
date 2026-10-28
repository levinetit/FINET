import { z } from "zod";

import { BUDGET_PERIODS, BUDGET_SCOPES, DB_CURRENCIES } from "@/db/schema";
import { isMonth } from "@/lib/calendar";
import { type Currency, money, toJson } from "@/lib/money";
import { amountTextSchema, idSchema, notBoth, positiveMinorSchema } from "@/modules/ledger/input";

/** Bugetele lunare (Faza 3, 6.1). Zod strict: `householdId` și `userId` sunt respinse. */

export const DEFAULT_WARN_PCT = 80;

const amountRefine = { message: "Trimite suma o singură dată (amountMinor sau amount)." };

export const monthSchema = z
  .string()
  .refine(isMonth, { message: "Luna trebuie să fie de forma AAAA-LL." });

export const budgetCreateSchema = z
  .strictObject({
    // Lipsă/null = buget general (toate cheltuielile în moneda bugetului).
    categoryId: idSchema.nullable().optional(),
    amountMinor: positiveMinorSchema.optional(),
    amount: amountTextSchema.optional(),
    currency: z.enum(DB_CURRENCIES),
    warnPct: z.number().int().min(1).max(100).optional(),
    // `personal` = al utilizatorului curent (din sesiune), vizibil doar lui.
    scope: z.enum(BUDGET_SCOPES).optional(),
  })
  .refine(notBoth, amountRefine);

/** Categoria, moneda și domeniul nu se schimbă (alt buget = buget nou). */
export const budgetUpdateSchema = z
  .strictObject({
    amountMinor: positiveMinorSchema.optional(),
    amount: amountTextSchema.optional(),
    warnPct: z.number().int().min(1).max(100).optional(),
    archived: z.boolean().optional(),
  })
  .refine(notBoth, amountRefine)
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nimic de modificat.",
  });

export const budgetListSchema = z
  .strictObject({ includeArchived: z.boolean().optional() })
  .optional();

export const budgetStatusQuerySchema = z.strictObject({ month: monthSchema.optional() }).optional();

export type BudgetStatusColor = "green" | "yellow" | "red";

export type BudgetView = Readonly<{
  id: string;
  categoryId: string | null;
  period: (typeof BUDGET_PERIODS)[number];
  amountMinor: bigint;
  currency: Currency;
  warnPct: number;
  scope: (typeof BUDGET_SCOPES)[number];
  userId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

/** Starea unui buget într-o lună: cât s-a cheltuit, cât a rămas, procentul și semaforul. */
export type BudgetStatus = BudgetView &
  Readonly<{
    month: string;
    spentMinor: bigint;
    /** Poate fi negativ (depășire). */
    remainingMinor: bigint;
    /** `floor(spent × 100 / amount)`, limitat la 1.000.000 (doar afișare). */
    percent: number;
    status: BudgetStatusColor;
  }>;

export type BudgetJson = Omit<
  BudgetView,
  "amountMinor" | "archivedAt" | "createdAt" | "updatedAt"
> & {
  amountMinor: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BudgetStatusJson = BudgetJson & {
  month: string;
  spentMinor: number;
  remainingMinor: number;
  percent: number;
  status: BudgetStatusColor;
};

const minorJson = (v: bigint, c: Currency) => toJson(money(v, c)).amountMinor;

export function budgetToJson(b: BudgetView): BudgetJson {
  return {
    id: b.id,
    categoryId: b.categoryId,
    period: b.period,
    amountMinor: minorJson(b.amountMinor, b.currency),
    currency: b.currency,
    warnPct: b.warnPct,
    scope: b.scope,
    userId: b.userId,
    archivedAt: b.archivedAt?.toISOString() ?? null,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

export function budgetStatusToJson(s: BudgetStatus): BudgetStatusJson {
  return {
    ...budgetToJson(s),
    month: s.month,
    spentMinor: minorJson(s.spentMinor, s.currency),
    remainingMinor: minorJson(s.remainingMinor, s.currency),
    percent: s.percent,
    status: s.status,
  };
}
