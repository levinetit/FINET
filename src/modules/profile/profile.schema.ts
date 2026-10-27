import { z } from "zod";

import { DB_CURRENCIES, THEMES } from "@/db/schema";

/**
 * `PATCH /api/v1/me` (Zod strict: orice cheie necunoscută, de exemplu `household_id`,
 * `householdId`, `is_platform_admin` sau `email`, e respinsă cu 400).
 */

/** Limbile interfeței (decizia mea: româna; engleza rezervată pentru mai târziu). */
export const LOCALES = ["ro-RO", "en-US"] as const;

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const preferencesPatchSchema = z.strictObject({
  locale: z.enum(LOCALES).optional(),
  timezone: z
    .string()
    .min(1)
    .max(64)
    .refine(isValidTimeZone, { message: "Fus orar necunoscut." })
    .optional(),
  theme: z.enum(THEMES).optional(),
  defaultCurrency: z.enum(DB_CURRENCIES).optional(),
});

export const profilePatchSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100).optional(),
    preferences: preferencesPatchSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.preferences !== undefined, {
    message: "Nimic de modificat.",
  });

export type ProfilePatch = z.infer<typeof profilePatchSchema>;
