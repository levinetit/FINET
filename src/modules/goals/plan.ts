import { z } from "zod";

import { DB_CURRENCIES } from "@/db/schema";
import { type CalendarDate, dayNumber } from "@/lib/calendar";
import type { Currency } from "@/lib/money";
import { amountTextSchema, dateSchema, positiveMinorSchema, notBoth } from "@/modules/ledger/input";
import { divRound } from "@/modules/health/health";

/**
 * Planul de economisire (modernizare 2026, pasul H; ADR 0047): funcții PURE, în `bigint`, peste
 * obiectivele existente (ADR 0007). Nu atinge conturile bancare și nu creează nimic: spune cât
 * trebuie pus deoparte pe zi / săptămână / lună ca ținta să fie atinsă la termen, sau cât durează
 * la o rată aleasă. Rotunjirile sunt în SUS (planul nu rămâne niciodată sub țintă).
 *
 * Fondul de urgență: ținta = `months` × cheltuiala lunară medie (ultimele 3 luni cu cheltuieli,
 * ca la scorul de sănătate), rata lunară = diferența / lunile alese pentru a ajunge acolo.
 */

export const DAYS_PER_MONTH_X100 = 3044n; // 365,25 / 12 = 30,44 zile, în sutimi
export const DAYS_PER_WEEK = 7n;
export const EMERGENCY_MONTHS_OPTIONS = [3, 6] as const;
export const EMERGENCY_REACH_MONTHS = 12n;
export const MAX_PLAN_MONTHS = 600n;

export type PlanStatus = "done" | "no_deadline" | "on_track" | "overdue";

export type SavingsPlan = Readonly<{
  remainingMinor: bigint;
  /** Zilele rămase până la termen (≥ 0), `null` fără termen. */
  daysLeft: number | null;
  /** Suma de pus deoparte pe zi / săptămână / lună ca să ajungi la țintă la termen. */
  dailyMinor: bigint | null;
  weeklyMinor: bigint | null;
  monthlyMinor: bigint | null;
  status: PlanStatus;
}>;

/** Împărțire cu rotunjire în sus (planul nu subestimează niciodată). */
export function divCeil(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new RangeError("împărțitor nepozitiv");
  if (num <= 0n) return 0n;
  return (num + den - 1n) / den;
}

export function savingsPlan(
  input: Readonly<{
    targetMinor: bigint;
    savedMinor: bigint;
    deadline: CalendarDate | null;
    today: CalendarDate;
  }>,
): SavingsPlan {
  const remaining = input.targetMinor - input.savedMinor;
  if (remaining <= 0n) {
    return {
      remainingMinor: 0n,
      daysLeft: input.deadline
        ? Math.max(0, dayNumber(input.deadline) - dayNumber(input.today))
        : null,
      dailyMinor: 0n,
      weeklyMinor: 0n,
      monthlyMinor: 0n,
      status: "done",
    };
  }
  if (!input.deadline) {
    return {
      remainingMinor: remaining,
      daysLeft: null,
      dailyMinor: null,
      weeklyMinor: null,
      monthlyMinor: null,
      status: "no_deadline",
    };
  }
  const days = dayNumber(input.deadline) - dayNumber(input.today);
  if (days <= 0) {
    return {
      remainingMinor: remaining,
      daysLeft: 0,
      dailyMinor: remaining,
      weeklyMinor: remaining,
      monthlyMinor: remaining,
      status: "overdue",
    };
  }
  const d = BigInt(days);
  const daily = divCeil(remaining, d);
  // Săptămâni și luni rămase (fracționare): rata = restul / (zile / zile-pe-perioadă), rotunjit în sus.
  const weekly = days < 7 ? remaining : divCeil(remaining * DAYS_PER_WEEK, d);
  const monthly =
    d * 100n < DAYS_PER_MONTH_X100 ? remaining : divCeil(remaining * DAYS_PER_MONTH_X100, d * 100n);
  return {
    remainingMinor: remaining,
    daysLeft: days,
    dailyMinor: daily,
    weeklyMinor: weekly,
    monthlyMinor: monthly,
    status: "on_track",
  };
}

/** Câte luni durează până la țintă cu o rată lunară fixă (rotunjit în sus; `null` la rată 0). */
export function monthsToReach(remainingMinor: bigint, monthlyMinor: bigint): number | null {
  if (remainingMinor <= 0n) return 0;
  if (monthlyMinor <= 0n) return null;
  const months = divCeil(remainingMinor, monthlyMinor);
  return Number(months > MAX_PLAN_MONTHS ? MAX_PLAN_MONTHS : months);
}

export type EmergencyFundPlan = Readonly<{
  currency: Currency;
  /** Cheltuiala lunară medie (ultimele 3 luni cu cheltuieli); `null` fără date. */
  averageExpenseMinor: bigint | null;
  liquidMinor: bigint;
  options: readonly Readonly<{
    months: number;
    targetMinor: bigint;
    gapMinor: bigint;
    /** Rata lunară ca să acoperi diferența în `EMERGENCY_REACH_MONTHS` luni. */
    monthlyMinor: bigint;
    /** Câte luni de cheltuieli acoperă azi lichidul, în sutimi. */
    coveredX100: number;
  }>[];
}>;

export function emergencyFundPlan(
  currency: Currency,
  averageExpenseMinor: bigint | null,
  liquidMinor: bigint,
): EmergencyFundPlan {
  const liquid = liquidMinor < 0n ? 0n : liquidMinor;
  if (averageExpenseMinor === null || averageExpenseMinor <= 0n) {
    return { currency, averageExpenseMinor: null, liquidMinor: liquid, options: [] };
  }
  const covered = Number(divRound(liquid * 100n, averageExpenseMinor));
  return {
    currency,
    averageExpenseMinor,
    liquidMinor: liquid,
    options: EMERGENCY_MONTHS_OPTIONS.map((months) => {
      const target = averageExpenseMinor * BigInt(months);
      const gap = target > liquid ? target - liquid : 0n;
      return {
        months,
        targetMinor: target,
        gapMinor: gap,
        monthlyMinor: divCeil(gap, EMERGENCY_REACH_MONTHS),
        coveredX100: Math.min(covered, months * 100),
      };
    }),
  };
}

/** Simularea unui plan (fără scriere): ținta, cât ai deja, și fie termenul, fie rata lunară. */
export const savingsSimulateSchema = z
  .strictObject({
    currency: z.enum(DB_CURRENCIES),
    targetMinor: positiveMinorSchema.optional(),
    target: amountTextSchema.optional(),
    savedMinor: z.number().int().min(0).max(10_000_000_000_000).optional(),
    deadline: dateSchema.nullable().optional(),
    monthlyMinor: positiveMinorSchema.optional(),
    monthly: amountTextSchema.optional(),
  })
  .refine((v) => notBoth({ amountMinor: v.targetMinor, amount: v.target }), {
    message: "Trimite ținta o singură dată (targetMinor sau target).",
  })
  .refine((v) => v.targetMinor !== undefined || v.target !== undefined, {
    message: "Ținta lipsește.",
  })
  .refine((v) => notBoth({ amountMinor: v.monthlyMinor, amount: v.monthly }), {
    message: "Trimite rata lunară o singură dată (monthlyMinor sau monthly).",
  });

export type SavingsSimulation = Readonly<{
  currency: Currency;
  targetMinor: bigint;
  savedMinor: bigint;
  today: CalendarDate;
  /** Planul la termen (dacă s-a dat un termen). */
  byDeadline: (SavingsPlan & { deadline: CalendarDate }) | null;
  /** Durata la rata lunară dată (dacă s-a dat o rată). */
  byMonthly: Readonly<{
    monthlyMinor: bigint;
    months: number | null;
    finishOn: CalendarDate | null;
  }> | null;
}>;
