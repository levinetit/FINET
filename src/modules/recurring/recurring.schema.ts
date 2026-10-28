import { z } from "zod";

import {
  RECURRING_FREQUENCIES,
  RECURRING_MAX_INTERVAL,
  RECURRING_MAX_OCCURRENCES,
  RECURRING_STATUSES,
  RECURRING_TYPES,
} from "@/db/schema";
import { type Currency, money, toJson } from "@/lib/money";
import {
  amountTextSchema,
  dateSchema,
  idSchema,
  notBoth,
  optionalText,
  positiveMinorSchema,
  requiredName,
} from "@/modules/ledger/input";

/**
 * Regulile recurente (Faza 5, 6.1; ADR 0011). Zod strict: o cheie necunoscută (de exemplu
 * `householdId`, `status`, `nextRunOn`) e respinsă; starea se schimbă doar prin pauză/reluare,
 * iar scadența o calculează serviciul. Mesajele sunt fixe și nu repetă valoarea primită.
 */

export const RECURRING_DESCRIPTION_MAX = 500;
export const RECURRING_MERCHANT_MAX = 200;
/** Recuperarea limitată: cel mult atâtea ocurențe ratate generate pe regulă la o rulare. */
export const MAX_CATCH_UP_PER_RUN = 12;

const amountRefine = { message: "Trimite suma o singură dată (amountMinor sau amount)." };

const intervalSchema = z
  .number()
  .int()
  .min(1)
  .max(RECURRING_MAX_INTERVAL, `Intervalul e cel mult ${RECURRING_MAX_INTERVAL}.`);
const dayOfMonthSchema = z.number().int().min(1).max(31);
const maxOccurrencesSchema = z
  .number()
  .int()
  .min(1)
  .max(RECURRING_MAX_OCCURRENCES, `Cel mult ${RECURRING_MAX_OCCURRENCES} de rate.`);

const usesDayOfMonth = (f: (typeof RECURRING_FREQUENCIES)[number]) =>
  f === "monthly" || f === "yearly";

export const recurringCreateSchema = z
  .strictObject({
    accountId: idSchema,
    categoryId: idSchema.nullable().optional(),
    type: z.enum(RECURRING_TYPES),
    amountMinor: positiveMinorSchema.optional(),
    amount: amountTextSchema.optional(),
    description: requiredName(RECURRING_DESCRIPTION_MAX),
    merchant: optionalText(RECURRING_MERCHANT_MAX),
    frequency: z.enum(RECURRING_FREQUENCIES),
    interval: intervalSchema.optional(),
    // Lunar/anual: implicit ziua din `startOn`; zilnic/săptămânal: nu se trimite.
    dayOfMonth: dayOfMonthSchema.optional(),
    startOn: dateSchema,
    endOn: dateSchema.nullable().optional(),
    maxOccurrences: maxOccurrencesSchema.nullable().optional(),
  })
  .refine(notBoth, amountRefine)
  .refine((v) => v.dayOfMonth === undefined || usesDayOfMonth(v.frequency), {
    message: "Ziua din lună se dă doar pentru regulile lunare sau anuale.",
  })
  .refine((v) => !v.endOn || v.endOn >= v.startOn, {
    message: "Data de sfârșit e înaintea datei de început.",
  });

export const recurringUpdateSchema = z
  .strictObject({
    accountId: idSchema.optional(),
    categoryId: idSchema.nullable().optional(),
    amountMinor: positiveMinorSchema.optional(),
    amount: amountTextSchema.optional(),
    description: requiredName(RECURRING_DESCRIPTION_MAX).optional(),
    merchant: optionalText(RECURRING_MERCHANT_MAX),
    frequency: z.enum(RECURRING_FREQUENCIES).optional(),
    interval: intervalSchema.optional(),
    dayOfMonth: dayOfMonthSchema.nullable().optional(),
    endOn: dateSchema.nullable().optional(),
    maxOccurrences: maxOccurrencesSchema.nullable().optional(),
  })
  .refine(notBoth, amountRefine)
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nimic de modificat.",
  });

export const recurringListSchema = z
  .strictObject({ status: z.enum(RECURRING_STATUSES).optional() })
  .optional();

export type RecurringStatus = (typeof RECURRING_STATUSES)[number];
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number];

export type RecurringRuleView = Readonly<{
  id: string;
  accountId: string;
  categoryId: string | null;
  type: (typeof RECURRING_TYPES)[number];
  amountMinor: bigint;
  currency: Currency;
  description: string;
  merchant: string | null;
  frequency: RecurringFrequency;
  interval: number;
  dayOfMonth: number | null;
  startOn: string;
  nextRunOn: string;
  endOn: string | null;
  maxOccurrences: number | null;
  occurrencesCount: number;
  status: RecurringStatus;
  /** `true` dacă regula e activă și are o scadență negenerată ≤ azi. */
  due: boolean;
  /** Codul ultimei generări eșuate (fără detalii), dacă există. */
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

/** Contorul paginii: „X active · Y de generat · Z total”. */
export type RecurringCounts = Readonly<{ active: number; due: number; total: number }>;

export type RecurringList = Readonly<{ data: RecurringRuleView[]; counts: RecurringCounts }>;

export type RecurringRuleJson = Omit<
  RecurringRuleView,
  "amountMinor" | "createdAt" | "updatedAt"
> & {
  amountMinor: number;
  createdAt: string;
  updatedAt: string;
};

export function recurringRuleToJson(r: RecurringRuleView): RecurringRuleJson {
  return {
    ...r,
    amountMinor: toJson(money(r.amountMinor, r.currency)).amountMinor,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Rezultatul generării pentru o regulă (fără sume sau descrieri: îl scrie și workerul în log). */
export type GenerateOutcome =
  "generated" | "not_due" | "inactive" | "skipped_locked" | "paused_account_archived";

export type GenerateResult = Readonly<{
  outcome: GenerateOutcome;
  /** Câte tranzacții noi au fost create acum. */
  generated: number;
  status: RecurringStatus;
  nextRunOn: string;
  /** `true` dacă au rămas scadențe ≤ azi (recuperarea limitată le lasă pe rularea următoare). */
  remainingDue: boolean;
}>;
