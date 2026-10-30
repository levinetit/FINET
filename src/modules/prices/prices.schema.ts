import { z } from "zod";

import { CURRENCIES } from "@/lib/money";
import { INFLATION_BASELINES } from "@/lib/periods";
import { safe } from "@/lib/safe-number";

import type { InflationItem, InflationResult } from "./inflation";
import {
  GRANULARITIES,
  type MerchantPrice,
  type PriceSeries,
  type PriceThresholds,
  type ProductSummary,
} from "./prices";

/**
 * Intrările și ieșirile API pentru prețuri și inflație (Faza 10, F10-B; ADR 0023). Parametrii
 * pragurilor sunt opționali și plafonați; implicit se folosesc constantele documentate din
 * `prices.ts` / `inflation.ts`. Procentele ies ca întregi în puncte de bază (`…Bps`, 1 pb = 0,01 %).
 */

export const PRICE_WINDOW_MONTHS_DEFAULT = 12;
export const PRICE_WINDOW_MONTHS_MAX = 60;
export const PRODUCTS_LIMIT_DEFAULT = 100;
export const PRODUCTS_LIMIT_MAX = 200;
export const INFLATION_MONTHS_DEFAULT = 3;
export const INFLATION_MONTHS_MAX = 12;

const months = z.number().int().min(1).max(PRICE_WINDOW_MONTHS_MAX);
const thresholdParts = {
  minObservations: z.number().int().min(1).max(50).optional(),
  minMonths: z.number().int().min(1).max(24).optional(),
};
const currency = z.enum(CURRENCIES);

export const productsQuerySchema = z
  .strictObject({
    months: months.optional(),
    search: z.string().max(80).optional(),
    currency: currency.optional(),
    onlyEnough: z.boolean().optional(),
    limit: z.number().int().min(1).max(PRODUCTS_LIMIT_MAX).optional(),
    ...thresholdParts,
  })
  .optional();
export type ProductsQuery = NonNullable<z.infer<typeof productsQuerySchema>>;

export const seriesQuerySchema = z.strictObject({
  product: z.string().min(3).max(320),
  currency: currency.optional(),
  granularity: z.enum(GRANULARITIES).optional(),
  months: months.optional(),
  ...thresholdParts,
});
export type SeriesQuery = z.infer<typeof seriesQuerySchema>;

export const inflationQuerySchema = z
  .strictObject({
    months: z.number().int().min(1).max(INFLATION_MONTHS_MAX).optional(),
    baseline: z.enum(INFLATION_BASELINES).optional(),
    minObservations: z.number().int().min(1).max(20).optional(),
    minItems: z.number().int().min(1).max(50).optional(),
  })
  .optional();
export type InflationQuery = NonNullable<z.infer<typeof inflationQuerySchema>>;

export function thresholdsOf(q: {
  minObservations?: number | undefined;
  minMonths?: number | undefined;
}): Partial<PriceThresholds> {
  return {
    ...(q.minObservations === undefined ? {} : { minObservations: q.minObservations }),
    ...(q.minMonths === undefined ? {} : { minMonths: q.minMonths }),
  };
}

// --- Ieșirea JSON --------------------------------------------------------------------------------

const merchantJson = (m: MerchantPrice) => ({
  merchantKey: m.merchantKey,
  merchantName: m.merchantName,
  observations: m.observations,
  priceMinor: safe(m.priceMinor),
  lastOn: m.lastOn,
});

export function productToJson(p: ProductSummary) {
  return {
    productKey: p.productKey,
    name: p.name,
    unit: p.unit,
    currency: p.currency,
    observations: p.observations,
    months: p.months,
    firstOn: p.firstOn,
    lastOn: p.lastOn,
    enough: p.enough,
    priceMinor: p.priceMinor === null ? null : safe(p.priceMinor),
    merchants: p.merchants.map(merchantJson),
    cheapest:
      p.cheapest === null
        ? null
        : {
            cheapest: merchantJson(p.cheapest.cheapest),
            mostUsed: merchantJson(p.cheapest.mostUsed),
            diffMinor: safe(p.cheapest.diffMinor),
            diffBps: safe(p.cheapest.diffBps),
          },
  };
}

export type ProductsResult = Readonly<{
  from: string;
  to: string;
  thresholds: PriceThresholds;
  excludedLines: number;
  total: number;
  products: readonly ProductSummary[];
}>;

export function productsToJson(r: ProductsResult) {
  return {
    from: r.from,
    to: r.to,
    thresholds: r.thresholds,
    excludedLines: r.excludedLines,
    total: r.total,
    products: r.products.map(productToJson),
  };
}

export type SeriesResult = Readonly<{
  from: string;
  to: string;
  thresholds: PriceThresholds;
  series: PriceSeries;
}>;

export function seriesToJson(r: SeriesResult) {
  const point = (p: PriceSeries["overall"][number]) => ({
    bucket: p.bucket,
    priceMinor: safe(p.priceMinor),
    observations: p.observations,
  });
  return {
    from: r.from,
    to: r.to,
    thresholds: r.thresholds,
    productKey: r.series.productKey,
    name: r.series.name,
    unit: r.series.unit,
    currency: r.series.currency,
    granularity: r.series.granularity,
    enough: r.series.enough,
    overall: r.series.overall.map(point),
    byMerchant: r.series.byMerchant.map((m) => ({
      merchantKey: m.merchantKey,
      merchantName: m.merchantName,
      points: m.points.map(point),
    })),
  };
}

const itemToJson = (i: InflationItem) => ({
  productKey: i.productKey,
  name: i.name,
  unit: i.unit,
  merchantKey: i.merchantKey,
  merchantName: i.merchantName,
  baseObservations: i.baseObservations,
  currentObservations: i.currentObservations,
  basePriceMinor: safe(i.basePriceMinor),
  currentPriceMinor: safe(i.currentPriceMinor),
  baseSpendMinor: safe(i.baseSpendMinor),
  changeBps: safe(i.changeBps),
});

export type InflationOutput = Readonly<{
  months: number;
  baseline: (typeof INFLATION_BASELINES)[number];
  base: Readonly<{ from: string; to: string }>;
  current: Readonly<{ from: string; to: string }>;
  thresholds: Readonly<{ minObsPerPeriod: number; minItems: number; minMerchantItems: number }>;
  excludedLines: number;
  currencies: readonly InflationResult[];
}>;

export function inflationToJson(r: InflationOutput) {
  return {
    months: r.months,
    baseline: r.baseline,
    base: r.base,
    current: r.current,
    thresholds: r.thresholds,
    excludedLines: r.excludedLines,
    currencies: r.currencies.map((c) => ({
      currency: c.currency,
      status: c.status,
      itemsUsed: c.itemsUsed,
      coverageBps: safe(c.coverageBps),
      changeBps: c.changeBps === null ? null : safe(c.changeBps),
      byMerchant: c.byMerchant.map((m) => ({
        merchantKey: m.merchantKey,
        merchantName: m.merchantName,
        items: m.items,
        changeBps: m.changeBps === null ? null : safe(m.changeBps),
      })),
      items: c.items.map(itemToJson),
    })),
  };
}
