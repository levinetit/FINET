import { z } from "zod";

import { DB_CURRENCIES, RECEIPT_LINE_KINDS } from "@/db/schema";
import { INFLATION_BASELINES, REPORT_PERIODS } from "@/lib/periods";
import { GRANULARITIES } from "@/modules/prices/prices";
import { RULE_COMBINES, RULE_TYPES } from "@/modules/report-definitions/rules";

/**
 * Schemele RĂSPUNSURILOR pentru prețuri, inflație și rapoartele de micro-cheltuieli (Faza 10,
 * F10-B; ADR 0023), într-un fișier separat de `schemas.ts` (mai puține conflicte la integrarea
 * cu partea F10-A). Răspunsurile reale vin din funcțiile `*ToJson` ale modulelor; testele API le
 * verifică cu aceste scheme (`assertContract`).
 */

const uuid = z.uuid();
const instant = z.iso.datetime().meta({ description: "Moment ISO 8601 în UTC." });
const date = z.iso.date().meta({ description: "Dată calendaristică `YYYY-MM-DD`." });
const int = z.number().int();
const currency = z.enum(DB_CURRENCIES);
const minor = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)
  .meta({ description: "Sumă în unități minore (întreg, sub 2^53); niciodată zecimale." });
const bps = z
  .number()
  .int()
  .meta({ description: "Puncte de bază (1 pb = 0,01 %), întreg; 1250 = 12,50 %." });
const unit = z
  .enum(["kg", "l", "buc", "unit"])
  .meta({ description: "Unitatea de comparație: kg, l, bucată sau `unit` (unitatea de pe bon)." });

// --- Prețuri -------------------------------------------------------------------------------------

const merchantPrice = z.strictObject({
  merchantKey: z.string(),
  merchantName: z.string().nullable(),
  observations: int,
  priceMinor: minor,
  lastOn: date,
});

export const productSummarySchema = z
  .strictObject({
    productKey: z.string().meta({ description: "`<unitate>|<nume fără mărime>`." }),
    name: z.string(),
    unit,
    currency,
    observations: int,
    months: int,
    firstOn: date,
    lastOn: date,
    enough: z.boolean().meta({
      description:
        "`false` sub pragul de date: prețurile sunt `null`, UI-ul spune că lipsesc date.",
    }),
    priceMinor: minor.nullable().meta({
      description: "Media ponderată cu cantitatea, în unități minore pe unitatea de comparație.",
    }),
    merchants: z.array(merchantPrice),
    cheapest: z
      .strictObject({
        cheapest: merchantPrice,
        mostUsed: merchantPrice,
        diffMinor: minor,
        diffBps: bps,
      })
      .nullable(),
  })
  .meta({ title: "ProductPrice" });

export const productsResultSchema = z
  .strictObject({
    from: date,
    to: date,
    thresholds: z.strictObject({ minObservations: int, minMonths: int }),
    excludedLines: int.meta({ description: "Linii ignorate (mărime ambiguă sau sumă nulă)." }),
    total: int,
    products: z.array(productSummarySchema),
  })
  .meta({ title: "ProductPrices" });

const point = z.strictObject({ bucket: z.string(), priceMinor: minor, observations: int });

export const priceSeriesSchema = z
  .strictObject({
    from: date,
    to: date,
    thresholds: z.strictObject({ minObservations: int, minMonths: int }),
    productKey: z.string(),
    name: z.string(),
    unit,
    currency,
    granularity: z.enum(GRANULARITIES),
    enough: z.boolean(),
    overall: z.array(point),
    byMerchant: z.array(
      z.strictObject({
        merchantKey: z.string(),
        merchantName: z.string().nullable(),
        points: z.array(point),
      }),
    ),
  })
  .meta({ title: "PriceSeries" });

// --- Inflație ------------------------------------------------------------------------------------

const range = z.strictObject({ from: date, to: date });

export const inflationSchema = z
  .strictObject({
    months: int,
    baseline: z.enum(INFLATION_BASELINES),
    base: range,
    current: range,
    thresholds: z.strictObject({
      minObsPerPeriod: int,
      minItems: int,
      minMerchantItems: int,
    }),
    excludedLines: int,
    currencies: z.array(
      z.strictObject({
        currency,
        status: z.enum(["ok", "insufficient"]),
        itemsUsed: int,
        coverageBps: bps.meta({
          description: "Ponderea cheltuielii de bază acoperite de articolele folosite.",
        }),
        changeBps: bps.nullable().meta({
          description:
            "Variația gospodăriei (ponderată cu cheltuiala de bază); `null` sub pragul de articole. Estimare din bonurile tale.",
        }),
        byMerchant: z.array(
          z.strictObject({
            merchantKey: z.string(),
            merchantName: z.string().nullable(),
            items: int,
            changeBps: bps.nullable(),
          }),
        ),
        items: z.array(
          z.strictObject({
            productKey: z.string(),
            name: z.string(),
            unit,
            merchantKey: z.string(),
            merchantName: z.string().nullable(),
            baseObservations: int,
            currentObservations: int,
            basePriceMinor: minor,
            currentPriceMinor: minor,
            baseSpendMinor: minor,
            changeBps: bps,
          }),
        ),
      }),
    ),
  })
  .meta({ title: "PersonalInflation" });

// --- Rapoarte --------------------------------------------------------------------------------------

const term = z.strictObject({ type: z.enum(RULE_TYPES), value: z.string() });

export const reportRulesResponseSchema = z
  .strictObject({
    v: z.literal(1),
    combine: z.enum(RULE_COMBINES),
    include: z.array(term),
    exclude: z.array(term),
    kinds: z.array(z.enum(RECEIPT_LINE_KINDS)),
    categoryIds: z.array(uuid),
    tagIds: z.array(uuid),
  })
  .meta({ title: "ReportRules" });

export const reportDefinitionSchema = z
  .strictObject({
    id: uuid,
    name: z.string(),
    description: z.string().nullable(),
    advice: z.string().nullable(),
    rules: reportRulesResponseSchema,
    isSystem: z.boolean(),
    archived: z.boolean(),
    createdAt: instant,
    updatedAt: instant,
  })
  .meta({ title: "ReportDefinition" });

const projection = z.strictObject({
  status: z.enum(["ok", "insufficient"]),
  yearlyMinor: minor.nullable(),
  coverageDays: int,
  receipts: int,
});

export const reportRunSchema = z
  .strictObject({
    definition: reportDefinitionSchema.nullable(),
    period: z.enum(REPORT_PERIODS),
    from: date.nullable(),
    to: date.nullable(),
    coverage: z.strictObject({
      firstOn: date.nullable(),
      lastOn: date.nullable(),
      receipts: int,
    }),
    currencies: z.array(
      z.strictObject({
        currency,
        mode: z.enum(["standard", "savings"]),
        chargedMinor: minor,
        creditMinor: minor,
        netMinor: minor,
        totalMinor: minor,
        piecesMilli: int.meta({ description: "Cantitatea în miimi (1000 = o bucată)." }),
        avgUnitMinor: minor.nullable(),
        lineCount: int,
        receiptCount: int,
        projection,
        byMonth: z.array(z.strictObject({ month: z.string(), totalMinor: minor })),
      }),
    ),
    lines: z.array(
      z.strictObject({
        id: uuid,
        receiptId: uuid,
        occurredOn: date,
        merchantName: z.string().nullable(),
        name: z.string(),
        kind: z.enum(RECEIPT_LINE_KINDS),
        quantity: z.string().nullable(),
        currency,
        lineTotalMinor: minor,
      }),
    ),
    linesTruncated: z.boolean(),
    matchedLines: int,
  })
  .meta({ title: "ReportRun" });
