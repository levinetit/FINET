import { z } from "zod";

import { REPORT_NAME_MAX, REPORT_TEXT_MAX } from "@/db/schema";
import { type Currency } from "@/lib/money";
import { safe } from "@/lib/safe-number";
import { REPORT_PERIODS, type ReportPeriod } from "@/lib/periods";
import { cleanText } from "@/modules/receipts/normalize";

import { type ReportRules, reportRulesSchema } from "./rules";
import type { CurrencyRun, ReportRun } from "./run";

/**
 * Intrările și ieșirile API pentru rapoartele de micro-cheltuieli (Faza 10, F10-B; ADR 0023).
 * Zod STRICT: o cheie necunoscută (de exemplu `householdId`, `isSystem`) e respinsă. Textele
 * libere (nume, descriere, sfat) se curăță de caractere de control/bidi (`cleanText`) și se
 * plafonează; regulile au schema din `rules.ts`.
 */

export const DEFAULT_REPORT_PERIOD: ReportPeriod = "all";

const text = (max: number, min = 0) =>
  z
    .string()
    .max(max * 2)
    .transform((v, ctx) => {
      const cleaned = cleanText(v, max);
      if (cleaned === null) {
        if (min === 0) return null;
        ctx.addIssue({ code: "custom", message: "Câmp obligatoriu." });
        return z.NEVER;
      }
      if (Array.from(v.trim()).length > max) {
        ctx.addIssue({ code: "custom", message: `Cel mult ${max} de caractere.` });
        return z.NEVER;
      }
      return cleaned;
    });

const nameSchema = text(REPORT_NAME_MAX, 1).transform((v) => v as string);
const optionalText = text(REPORT_TEXT_MAX).nullable().optional();

export const reportCreateSchema = z.strictObject({
  name: nameSchema,
  description: optionalText,
  advice: optionalText,
  rules: reportRulesSchema,
});
export type ReportCreate = z.infer<typeof reportCreateSchema>;

export const reportUpdateSchema = z
  .strictObject({
    name: nameSchema.optional(),
    description: optionalText,
    advice: optionalText,
    rules: reportRulesSchema.optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nu e nimic de schimbat." });
export type ReportUpdate = z.infer<typeof reportUpdateSchema>;

export const periodSchema = z.enum(REPORT_PERIODS);

export const reportRunQuerySchema = z.strictObject({ period: periodSchema.optional() }).optional();
export const reportListQuerySchema = z
  .strictObject({ includeArchived: z.boolean().optional() })
  .optional();
export const reportPreviewSchema = z.strictObject({
  rules: reportRulesSchema,
  period: periodSchema.optional(),
});
export const reportExportQuerySchema = z
  .strictObject({ period: periodSchema.optional() })
  .optional();

export type ReportDefinitionView = Readonly<{
  id: string;
  name: string;
  description: string | null;
  advice: string | null;
  rules: ReportRules;
  isSystem: boolean;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
}>;

// --- Ieșirea JSON (bigint → număr sigur) -------------------------------------------------------

export function definitionToJson(d: ReportDefinitionView) {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    advice: d.advice,
    rules: d.rules,
    isSystem: d.isSystem,
    archived: d.archived,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

function currencyRunToJson(c: CurrencyRun) {
  return {
    currency: c.currency satisfies Currency,
    mode: c.mode,
    chargedMinor: safe(c.chargedMinor),
    creditMinor: safe(c.creditMinor),
    netMinor: safe(c.netMinor),
    totalMinor: safe(c.totalMinor),
    piecesMilli: safe(c.piecesMilli),
    avgUnitMinor: c.avgUnitMinor === null ? null : safe(c.avgUnitMinor),
    lineCount: c.lineCount,
    receiptCount: c.receiptCount,
    projection:
      c.projection.status === "ok"
        ? {
            status: "ok" as const,
            yearlyMinor: safe(c.projection.yearlyMinor),
            coverageDays: c.projection.coverageDays,
            receipts: c.projection.receipts,
          }
        : {
            status: "insufficient" as const,
            yearlyMinor: null,
            coverageDays: c.projection.coverageDays,
            receipts: c.projection.receipts,
          },
    byMonth: c.byMonth.map((m) => ({ month: m.month, totalMinor: safe(m.totalMinor) })),
  };
}

export type RunResult = Readonly<{
  definition: ReportDefinitionView | null;
  period: ReportPeriod;
  from: string | null;
  to: string | null;
  run: ReportRun;
  coverage: Readonly<{ firstOn: string | null; lastOn: string | null; receipts: number }>;
}>;

export function runToJson(r: RunResult) {
  return {
    definition: r.definition === null ? null : definitionToJson(r.definition),
    period: r.period,
    from: r.from,
    to: r.to,
    coverage: r.coverage,
    currencies: r.run.currencies.map(currencyRunToJson),
    lines: r.run.lines.map((l) => ({
      id: l.id,
      receiptId: l.receiptId,
      occurredOn: l.occurredOn,
      merchantName: l.merchantName,
      name: l.rawName,
      kind: l.kind,
      quantity: l.quantity,
      currency: l.currency,
      lineTotalMinor: safe(l.lineTotalMinor),
    })),
    linesTruncated: r.run.linesTruncated,
    matchedLines: r.run.matchedLines,
  };
}

/** Forma JSON a unei rulări (pentru componentele de interfață). */
export type RunJson = ReturnType<typeof runToJson>;
export type DefinitionJson = ReturnType<typeof definitionToJson>;
