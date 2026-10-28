import { z } from "zod";

import {
  ACCOUNT_TYPES,
  BUDGET_PERIODS,
  BUDGET_SCOPES,
  CATEGORY_KINDS,
  DB_CURRENCIES,
  GOAL_STATUSES,
  HOUSEHOLD_ROLES,
  THEMES,
  TRANSACTION_SOURCES,
  TRANSACTION_TYPES,
  TRANSFER_DIRECTIONS,
} from "@/db/schema";
import { sessionViewSchema } from "@/modules/sessions/sessions.schema";

/**
 * Schemele RĂSPUNSURILOR API (OpenAPI, ADR 0005). Răspunsurile reale sunt construite de funcțiile
 * `*ToJson` din module; testele de integrare verifică răspunsurile reale cu aceste scheme
 * (`assertContract` din `src/app/api/v1/_lib/testing.ts`, apelat la fiecare răspuns din testele
 * `src/app/api/v1/*.test.ts`), ca documentația să nu se depărteze de cod.
 */

const uuid = z.uuid();
const instant = z.iso.datetime().meta({ description: "Moment ISO 8601 în UTC." });
const date = z.iso.date().meta({ description: "Dată calendaristică `YYYY-MM-DD`." });
const minor = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)
  .meta({ description: "Sumă în unități minore (întreg, sub 2^53); niciodată zecimale." });
const currency = z.enum(DB_CURRENCIES);

export const errorSchema = z
  .strictObject({
    error: z.strictObject({
      code: z.string(),
      message: z.string(),
      fields: z.record(z.string(), z.string()).optional(),
      reason: z.string().optional(),
    }),
  })
  .meta({ title: "Error" });

export const moneySchema = z
  .strictObject({ amountMinor: minor, currency })
  .meta({ title: "Money" });

export const accountSchema = z
  .strictObject({
    id: uuid,
    name: z.string(),
    type: z.enum(ACCOUNT_TYPES),
    currency,
    openingBalanceMinor: minor,
    balanceMinor: minor.meta({ description: "Sold calculat (nu stocat)." }),
    bankCode: z.string().nullable(),
    ownerUserId: uuid.nullable(),
    archived: z.boolean(),
    archivedAt: instant.nullable(),
    createdAt: instant,
    updatedAt: instant,
  })
  .meta({ title: "Account" });

export const categorySchema = z
  .strictObject({
    id: uuid,
    name: z.string(),
    kind: z.enum(CATEGORY_KINDS),
    parentId: uuid.nullable(),
    icon: z.string().nullable(),
    color: z.string().nullable(),
    hidden: z.boolean(),
    isSystem: z.boolean(),
    systemKey: z.string().nullable(),
  })
  .meta({ title: "Category" });

export const transactionSchema = z
  .strictObject({
    id: uuid,
    accountId: uuid,
    categoryId: uuid.nullable(),
    type: z.enum(TRANSACTION_TYPES),
    amountMinor: minor,
    currency,
    occurredOn: date,
    description: z.string().nullable(),
    merchant: z.string().nullable(),
    notes: z.string().nullable(),
    source: z.enum(TRANSACTION_SOURCES),
    transferGroupId: uuid.nullable(),
    transferDirection: z.enum(TRANSFER_DIRECTIONS).nullable(),
    createdByUserId: uuid.nullable(),
    createdAt: instant,
    updatedAt: instant,
    tags: z
      .array(z.strictObject({ id: uuid, name: z.string(), color: z.string().nullable() }))
      .meta({ description: "Etichetele tranzacției (ordonate după nume); `[]` la transferuri." }),
  })
  .meta({ title: "Transaction" });

const transferLeg = z.strictObject({
  transactionId: uuid,
  accountId: uuid,
  amountMinor: minor,
  currency,
});

export const transferSchema = z
  .strictObject({
    id: uuid.meta({ description: "`transfer_group_id`." }),
    from: transferLeg,
    to: transferLeg,
    occurredOn: date,
    description: z.string().nullable(),
    notes: z.string().nullable(),
    createdByUserId: uuid.nullable(),
    createdAt: instant,
  })
  .meta({ title: "Transfer" });

export const householdSummarySchema = z
  .strictObject({
    id: uuid,
    name: z.string(),
    defaultCurrency: currency,
    timezone: z.string(),
    role: z.enum(HOUSEHOLD_ROLES),
    current: z.boolean(),
    joinedAt: instant,
  })
  .meta({ title: "HouseholdSummary" });

export const householdDetailSchema = householdSummarySchema
  .extend({
    members: z.array(
      z.strictObject({
        userId: uuid,
        name: z.string(),
        role: z.enum(HOUSEHOLD_ROLES),
        joinedAt: instant,
      }),
    ),
  })
  .meta({ title: "HouseholdDetail" });

export const consentStateSchema = z
  .strictObject({
    kind: z.enum(["usageStats", "externalAi", "externalAiStatements"]),
    granted: z.boolean(),
    grantedAt: instant.nullable(),
    revokedAt: instant.nullable(),
  })
  .meta({ title: "ConsentState" });

export const meSchema = z
  .strictObject({
    user: z.strictObject({
      id: uuid,
      email: z.string(),
      name: z.string(),
      emailVerified: z.boolean(),
      isPlatformAdmin: z.boolean(),
      createdAt: instant,
    }),
    preferences: z.strictObject({
      locale: z.string(),
      timezone: z.string(),
      defaultCurrency: currency,
      theme: z.enum(THEMES),
    }),
    household: z
      .strictObject({
        id: uuid,
        name: z.string(),
        defaultCurrency: currency,
        timezone: z.string(),
        role: z.enum(HOUSEHOLD_ROLES),
      })
      .nullable(),
  })
  .meta({ title: "Me" });

export const sessionSchema = sessionViewSchema.meta({ title: "Session" });

// --- Planificare și raportare (Faza 3, F3-B) --------------------------------------------------

const int = z.number().int();
const percent = int.meta({ description: "Procent întreg (fără float pe sume)." });

export const tagSchema = z
  .strictObject({
    id: uuid,
    name: z.string(),
    color: z.string().nullable(),
    hidden: z.boolean(),
    isSystem: z.boolean(),
    systemKey: z.string().nullable(),
    usageCount: int.meta({ description: "Tranzacțiile gospodăriei care au eticheta." }),
  })
  .meta({ title: "Tag" });

export const budgetSchema = z
  .strictObject({
    id: uuid,
    categoryId: uuid.nullable().meta({ description: "`null` = buget general." }),
    period: z.enum(BUDGET_PERIODS),
    amountMinor: minor,
    currency,
    warnPct: int,
    scope: z.enum(BUDGET_SCOPES),
    userId: uuid.nullable().meta({ description: "Proprietarul unui buget `personal`." }),
    archivedAt: instant.nullable(),
    createdAt: instant,
    updatedAt: instant,
  })
  .meta({ title: "Budget" });

export const budgetStatusSchema = budgetSchema
  .extend({
    month: z.string().meta({ description: "Luna `YYYY-MM`." }),
    spentMinor: minor.meta({
      description: "Cheltuielile lunii în moneda bugetului (fără transferuri).",
    }),
    remainingMinor: minor.meta({ description: "`amountMinor − spentMinor`; negativ la depășire." }),
    percent: percent.meta({
      description: "`floor(spent × 100 / amount)`, limitat la 1.000.000 (doar afișare).",
    }),
    status: z.enum(["green", "yellow", "red"]).meta({
      description:
        "Semaforul din comparații exacte: verde sub `warnPct`, galben de la `warnPct` până la 100% inclusiv, roșu peste 100%.",
    }),
  })
  .meta({ title: "BudgetStatus" });

export const goalSchema = z
  .strictObject({
    id: uuid,
    name: z.string(),
    targetMinor: minor,
    savedMinor: minor,
    currency,
    deadline: date.nullable(),
    status: z.enum(GOAL_STATUSES),
    accountId: uuid.nullable(),
    progressPct: percent.meta({
      description: "`floor(saved × 100 / target)`; poate trece de 100.",
    }),
    createdAt: instant,
    updatedAt: instant,
  })
  .meta({ title: "Goal" });

const totals = z.strictObject({
  incomeMinor: minor,
  expenseMinor: minor,
  netMinor: minor,
  transactionCount: int.meta({ description: "Venituri + cheltuieli (fără transferuri)." }),
});
const delta = z.strictObject({
  diffMinor: minor,
  percent: int.nullable().meta({ description: "`null` când luna anterioară e 0." }),
});

export const dashboardSchema = z
  .strictObject({
    month: z.string(),
    previousMonth: z.string(),
    onboarding: z.strictObject({
      hasAccount: z.boolean(),
      hasTransaction: z.boolean(),
      hasBudget: z.boolean(),
      hasGoal: z.boolean(),
      steps: z.array(
        z.strictObject({ key: z.enum(["import", "budget", "goal"]), done: z.boolean() }),
      ),
      completed: z.boolean(),
    }),
    currencies: z.array(
      z.strictObject({
        currency,
        totals,
        previous: totals,
        comparison: z.strictObject({ income: delta, expense: delta, net: delta }),
        byCategory: z.array(
          z.strictObject({
            categoryId: uuid.nullable(),
            name: z.string().nullable(),
            isOther: z.boolean(),
            amountMinor: minor,
            percent,
          }),
        ),
        monthly: z.array(
          z.strictObject({
            month: z.string(),
            incomeMinor: minor,
            expenseMinor: minor,
            netMinor: minor,
          }),
        ),
        daily: z.array(z.strictObject({ date, incomeMinor: minor, expenseMinor: minor })),
      }),
    ),
  })
  .meta({ title: "Dashboard" });

export const monthlyReportSchema = z
  .strictObject({
    month: z.string(),
    currencies: z.array(
      z.strictObject({
        currency,
        totals,
        byCategory: z.array(
          z.strictObject({
            categoryId: uuid.nullable(),
            name: z.string().nullable(),
            amountMinor: minor,
            count: int,
            percent,
            children: z.array(
              z.strictObject({
                categoryId: uuid.nullable(),
                name: z.string().nullable(),
                amountMinor: minor,
                count: int,
              }),
            ),
          }),
        ),
        topMerchants: z.array(
          z.strictObject({ merchant: z.string(), amountMinor: minor, count: int }),
        ),
      }),
    ),
    budgets: z.array(budgetStatusSchema),
    goals: z.array(goalSchema),
  })
  .meta({ title: "MonthlyReport" });

/** `{ data }` */
export const dataOf = <T extends z.ZodType>(schema: T) => z.strictObject({ data: schema });
