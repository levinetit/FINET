import { z } from "zod";

import { isMonth } from "@/lib/calendar";
import { idSchema, positiveMinorSchema } from "@/modules/ledger/input";

/**
 * Intrările serviciilor de extrase (Zod strict; ADR 0018). Sumele doar întregi `…Minor`.
 * `householdId` vine din sesiune, niciodată din corp.
 */

export const fxDecisionSchema = z.strictObject({
  rowNo: z.number().int().min(1).max(5000),
  /** `transfer` = schimb între conturile pe monede; `plain` = venit/cheltuială; `skip`. */
  mode: z.enum(["transfer", "plain", "skip"]),
  counterpartAccountId: idSchema.optional(),
  /** Suma în moneda contului-pereche, dacă extrasul nu o arată. */
  counterAmountMinor: positiveMinorSchema.optional(),
});

export const confirmImportSchema = z.strictObject({
  /** Obligatoriu când soldurile nu se potrivesc: utilizatorul a văzut motivele. */
  acknowledgeBalanceMismatch: z.boolean().optional(),
  /** Rânduri excluse de utilizator la previzualizare. */
  skipRows: z.array(z.number().int().min(1).max(5000)).max(5000).optional(),
  fx: z.array(fxDecisionSchema).max(5000).optional(),
});

export const cancelImportSchema = z.strictObject({
  /** Tranzacțiile modificate după import: păstrate sau șterse (cerut explicit când există). */
  editedPolicy: z.enum(["keep", "delete"]).optional(),
});

export const listImportsSchema = z.strictObject({
  accountId: idSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

const monthSchema = z.string().refine(isMonth, "Luna are forma AAAA-LL.");
export const coverageSchema = z
  .strictObject({ from: monthSchema, to: monthSchema })
  .refine((v) => v.from <= v.to, "Intervalul de luni e inversat.");

export type ConfirmImportInput = z.infer<typeof confirmImportSchema>;
export type CancelImportInput = z.infer<typeof cancelImportSchema>;
