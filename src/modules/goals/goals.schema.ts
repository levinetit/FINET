import { z } from "zod";

import { DB_CURRENCIES, GOAL_STATUSES } from "@/db/schema";
import { type Currency, money, toJson } from "@/lib/money";
import {
  MAX_AMOUNT_MINOR,
  amountTextSchema,
  dateSchema,
  idSchema,
  notBoth,
  positiveMinorSchema,
  requiredName,
} from "@/modules/ledger/input";

/** Obiectivele de economisire (Faza 3, 6.1). Zod strict: `householdId` e respins. */

export const GOAL_NAME_MAX = 100;

const amountRefine = { message: "Trimite suma o singură dată (amountMinor sau amount)." };
const targetRefine = {
  message: "Trimite ținta o singură dată (targetMinor sau target).",
};
const notBothTarget = (v: { targetMinor?: number; target?: string }) =>
  v.targetMinor === undefined || v.target === undefined;

export const goalCreateSchema = z
  .strictObject({
    name: requiredName(GOAL_NAME_MAX),
    targetMinor: positiveMinorSchema.optional(),
    target: amountTextSchema.optional(),
    currency: z.enum(DB_CURRENCIES),
    deadline: dateSchema.nullable().optional(),
    // Contul în care se strâng banii (opțional, aceeași gospodărie și aceeași monedă).
    accountId: idSchema.nullable().optional(),
  })
  .refine(notBothTarget, targetRefine);

/** `status` manual: doar `abandoned` (renunțare) sau `active` (reluare); `achieved` e calculat. */
export const goalUpdateSchema = z
  .strictObject({
    name: requiredName(GOAL_NAME_MAX).optional(),
    targetMinor: positiveMinorSchema.optional(),
    target: amountTextSchema.optional(),
    deadline: dateSchema.nullable().optional(),
    accountId: idSchema.nullable().optional(),
    status: z.enum(["active", "abandoned"]).optional(),
  })
  .refine(notBothTarget, targetRefine)
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nimic de modificat.",
  });

/** O contribuție: `direction` adaugă sau scoate suma din economisit (care nu scade sub 0). */
export const goalContributionSchema = z
  .strictObject({
    direction: z.enum(["add", "withdraw"]),
    amountMinor: positiveMinorSchema.optional(),
    amount: amountTextSchema.optional(),
  })
  .refine(notBoth, amountRefine);

export const goalListSchema = z
  .strictObject({ status: z.enum(GOAL_STATUSES).optional() })
  .optional();

export { MAX_AMOUNT_MINOR };

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export type GoalView = Readonly<{
  id: string;
  name: string;
  targetMinor: bigint;
  savedMinor: bigint;
  currency: Currency;
  deadline: string | null;
  status: GoalStatus;
  accountId: string | null;
  /** `floor(saved × 100 / target)` (poate trece de 100), limitat la 1.000.000. */
  progressPct: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export type GoalJson = Omit<GoalView, "targetMinor" | "savedMinor" | "createdAt" | "updatedAt"> & {
  targetMinor: number;
  savedMinor: number;
  createdAt: string;
  updatedAt: string;
};

export function goalToJson(g: GoalView): GoalJson {
  return {
    ...g,
    targetMinor: toJson(money(g.targetMinor, g.currency)).amountMinor,
    savedMinor: toJson(money(g.savedMinor, g.currency)).amountMinor,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  };
}
