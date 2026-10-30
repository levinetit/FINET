import type { Currency } from "@/lib/money";
import { weekStart } from "@/lib/periods";

import {
  type SizeInfo,
  type UnitDimension,
  comparisonQuantity,
  dimensionOf,
  divRound,
  cachedSizeParser,
  productKeyOf,
  quantityMilli,
  unitPriceMinor,
} from "./units";

/**
 * Prețurile pe produs normalizat și pe comerciant (Faza 10, F10-B; ADR 0023). Funcții PURE peste
 * liniile bonurilor CONFIRMATE (doar `kind = 'product'`); citirea din bază e în `prices.repo.ts`.
 *
 * - **Produs**: cheia `<unitate>|<nume fără mărime>` (`units.ts`): ambalajele diferite ale aceluiași
 *   produs (`cafea 250g`, `cafea 500g`) se compară pe kg; monedele nu se amestecă niciodată (orice
 *   rezultat e pe (produs, monedă)).
 * - **Comerciant**: CUI (fără `RO`) dacă există, altfel numele normalizat; linia fără niciuna intră
 *   în seria produsului, dar nu în comparațiile pe comerciant.
 * - **Prețul unei serii** = media PONDERATĂ cu cantitatea (`Σ total / Σ cantitate`, în bani pe
 *   unitatea de comparație, rotunjit jumătate în sus): rezistă la cantități diferite și se
 *   calculează exact pe `bigint`. (Mediana ar cere liniile individuale pe fiecare punct; media
 *   ponderată se compune din sume și rămâne corectă la agregare.)
 * - **Prag de date**: un produs are rezultate doar cu cel puțin `minObservations` linii în cel
 *   puțin `minMonths` luni; un comerciant intră în comparație cu cel puțin
 *   `PRICE_MIN_MERCHANT_OBSERVATIONS` linii, iar „cel mai ieftin” cere cel puțin două astfel de
 *   comercianți. Sub prag nu se afișează niciun preț.
 */

export const PRICE_MIN_OBSERVATIONS = 3;
export const PRICE_MIN_MONTHS = 2;
export const PRICE_MIN_MERCHANT_OBSERVATIONS = 2;

export type PriceThresholds = Readonly<{ minObservations: number; minMonths: number }>;
export const DEFAULT_PRICE_THRESHOLDS: PriceThresholds = {
  minObservations: PRICE_MIN_OBSERVATIONS,
  minMonths: PRICE_MIN_MONTHS,
};

/** O linie de bon confirmat, așa cum o citește interogarea. */
export type PriceLine = Readonly<{
  normalizedName: string;
  quantity: string | null;
  lineTotalMinor: bigint;
  occurredOn: string;
  currency: Currency;
  merchantKey: string | null;
  merchantName: string | null;
}>;

/** O observație de preț: linia clasificată (cheie de produs, numitor de comparație). */
export type PriceObs = Readonly<{
  productKey: string;
  /** Numele afișat al produsului (fără mărime). */
  name: string;
  unit: UnitDimension;
  currency: Currency;
  merchantKey: string | null;
  merchantName: string | null;
  occurredOn: string;
  totalMinor: bigint;
  /** Cantitatea de comparație (miimi × miimi), vezi `comparisonQuantity`. */
  denominator: bigint;
}>;

export type Observations = Readonly<{ obs: PriceObs[]; excluded: number }>;

/** Clasifică liniile: cele ambigue sau fără sumă pozitivă nu produc observații (sunt numărate). */
export function toObservations(lines: readonly PriceLine[]): Observations {
  const obs: PriceObs[] = [];
  let excluded = 0;
  const parse = cachedSizeParser();
  for (const l of lines) {
    const qty = quantityMilli(l.quantity);
    const size: SizeInfo = parse(l.normalizedName, qty);
    const key = productKeyOf(size);
    const unit = dimensionOf(size);
    if (key === null || unit === null || l.lineTotalMinor <= 0n || qty <= 0n) {
      excluded += 1;
      continue;
    }
    obs.push({
      productKey: key,
      name: size.kind === "ambiguous" ? l.normalizedName : size.baseName,
      unit,
      currency: l.currency,
      merchantKey: l.merchantKey,
      merchantName: l.merchantName,
      occurredOn: l.occurredOn,
      totalMinor: l.lineTotalMinor,
      denominator: comparisonQuantity(size, qty),
    });
  }
  return { obs, excluded };
}

/** Prețul mediu ponderat (bani pe unitatea de comparație) al unui grup de observații. */
export function weightedPrice(group: readonly PriceObs[]): bigint | null {
  let total = 0n;
  let denominator = 0n;
  for (const o of group) {
    total += o.totalMinor;
    denominator += o.denominator;
  }
  return unitPriceMinor(total, denominator);
}

const groupBy = <T>(list: readonly T[], key: (x: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const x of list) {
    const k = key(x);
    const g = m.get(k);
    if (g) g.push(x);
    else m.set(k, [x]);
  }
  return m;
};

export type MerchantPrice = Readonly<{
  merchantKey: string;
  merchantName: string | null;
  observations: number;
  priceMinor: bigint;
  lastOn: string;
}>;

export type CheapestMerchant = Readonly<{
  cheapest: MerchantPrice;
  /** Comerciantul cu cele mai multe observații (de la care cumperi cel mai des). */
  mostUsed: MerchantPrice;
  /** Diferența de preț pe unitate față de comerciantul uzual (0 dacă e chiar el). */
  diffMinor: bigint;
  /** Aceeași diferență, în puncte de bază (1 pb = 0,01 %) din prețul comerciantului uzual. */
  diffBps: bigint;
}>;

export type ProductSummary = Readonly<{
  productKey: string;
  name: string;
  unit: UnitDimension;
  currency: Currency;
  observations: number;
  months: number;
  firstOn: string;
  lastOn: string;
  /** Sub prag: `false` și toate prețurile `null`. */
  enough: boolean;
  priceMinor: bigint | null;
  merchants: readonly MerchantPrice[];
  cheapest: CheapestMerchant | null;
}>;

function merchantPrices(group: readonly PriceObs[]): MerchantPrice[] {
  const withMerchant = group.filter((o) => o.merchantKey !== null);
  const byMerchant = groupBy(withMerchant, (o) => o.merchantKey!);
  const out: MerchantPrice[] = [];
  for (const [merchantKey, g] of byMerchant) {
    const price = weightedPrice(g);
    if (price === null) continue;
    const last = g.reduce((a, b) => (b.occurredOn > a.occurredOn ? b : a));
    out.push({
      merchantKey,
      merchantName: last.merchantName,
      observations: g.length,
      priceMinor: price,
      lastOn: last.occurredOn,
    });
  }
  // Ordine fixă: preț crescător, apoi mai multe observații, apoi cheia.
  return out.sort((a, b) =>
    a.priceMinor !== b.priceMinor
      ? a.priceMinor < b.priceMinor
        ? -1
        : 1
      : b.observations !== a.observations
        ? b.observations - a.observations
        : a.merchantKey.localeCompare(b.merchantKey),
  );
}

/** „Cel mai ieftin” DOAR între comercianți cu destule observații; cel puțin doi. */
export function cheapestMerchant(merchants: readonly MerchantPrice[]): CheapestMerchant | null {
  const eligible = merchants.filter((m) => m.observations >= PRICE_MIN_MERCHANT_OBSERVATIONS);
  if (eligible.length < 2) return null;
  const cheapest = eligible[0]!;
  const mostUsed = eligible.reduce((a, b) =>
    b.observations > a.observations ||
    (b.observations === a.observations && b.priceMinor < a.priceMinor)
      ? b
      : a,
  );
  const diff = mostUsed.priceMinor - cheapest.priceMinor;
  return {
    cheapest,
    mostUsed,
    diffMinor: diff,
    diffBps: mostUsed.priceMinor > 0n ? divRound(diff * 10_000n, mostUsed.priceMinor) : 0n,
  };
}

const monthOf = (d: string) => d.slice(0, 7);

/** Rezumatul pe (produs, monedă); produsele cu cele mai multe observații primele. */
export function summarizeProducts(
  observations: readonly PriceObs[],
  thresholds: PriceThresholds = DEFAULT_PRICE_THRESHOLDS,
): ProductSummary[] {
  const groups = groupBy(observations, (o) => `${o.currency}\u0000${o.productKey}`);
  const out: ProductSummary[] = [];
  for (const g of groups.values()) {
    const first = g[0]!;
    const months = new Set(g.map((o) => monthOf(o.occurredOn))).size;
    const dates = g.map((o) => o.occurredOn).sort();
    const enough = g.length >= thresholds.minObservations && months >= thresholds.minMonths;
    const merchants = enough ? merchantPrices(g) : [];
    out.push({
      productKey: first.productKey,
      name: first.name,
      unit: first.unit,
      currency: first.currency,
      observations: g.length,
      months,
      firstOn: dates[0]!,
      lastOn: dates[dates.length - 1]!,
      enough,
      priceMinor: enough ? weightedPrice(g) : null,
      merchants,
      cheapest: enough ? cheapestMerchant(merchants) : null,
    });
  }
  return out.sort(
    (a, b) =>
      b.observations - a.observations ||
      a.name.localeCompare(b.name, "ro") ||
      a.currency.localeCompare(b.currency),
  );
}

export const GRANULARITIES = ["month", "week"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

export type SeriesPoint = Readonly<{
  /** `YYYY-MM` (lună) sau data de luni `YYYY-MM-DD` (săptămână). */
  bucket: string;
  priceMinor: bigint;
  observations: number;
}>;

export type PriceSeries = Readonly<{
  productKey: string;
  name: string;
  unit: UnitDimension;
  currency: Currency;
  granularity: Granularity;
  enough: boolean;
  overall: readonly SeriesPoint[];
  byMerchant: ReadonlyArray<
    Readonly<{ merchantKey: string; merchantName: string | null; points: readonly SeriesPoint[] }>
  >;
}>;

const bucketOf = (date: string, granularity: Granularity) =>
  granularity === "month" ? monthOf(date) : weekStart(date);

function pointsOf(group: readonly PriceObs[], granularity: Granularity): SeriesPoint[] {
  const buckets = groupBy(group, (o) => bucketOf(o.occurredOn, granularity));
  const out: SeriesPoint[] = [];
  for (const [bucket, g] of buckets) {
    const price = weightedPrice(g);
    if (price !== null) out.push({ bucket, priceMinor: price, observations: g.length });
  }
  return out.sort((a, b) => a.bucket.localeCompare(b.bucket));
}

/**
 * Evoluția prețului unui produs (într-o monedă): seria generală și câte una pe comerciant (doar
 * comercianții cu destule observații). Sub prag: `enough = false` și serii goale.
 */
export function buildSeries(
  observations: readonly PriceObs[],
  productKey: string,
  currency: Currency,
  granularity: Granularity,
  thresholds: PriceThresholds = DEFAULT_PRICE_THRESHOLDS,
): PriceSeries | null {
  const g = observations.filter((o) => o.productKey === productKey && o.currency === currency);
  if (g.length === 0) return null;
  const first = g[0]!;
  const months = new Set(g.map((o) => monthOf(o.occurredOn))).size;
  const enough = g.length >= thresholds.minObservations && months >= thresholds.minMonths;
  const base = {
    productKey,
    name: first.name,
    unit: first.unit,
    currency,
    granularity,
    enough,
  } as const;
  if (!enough) return { ...base, overall: [], byMerchant: [] };
  const byMerchant = [
    ...groupBy(
      g.filter((o) => o.merchantKey !== null),
      (o) => o.merchantKey!,
    ),
  ]
    .filter(([, mg]) => mg.length >= PRICE_MIN_MERCHANT_OBSERVATIONS)
    .map(([merchantKey, mg]) => ({
      merchantKey,
      merchantName: mg.reduce((a, b) => (b.occurredOn > a.occurredOn ? b : a)).merchantName,
      points: pointsOf(mg, granularity),
    }))
    .sort((a, b) => a.merchantKey.localeCompare(b.merchantKey));
  return { ...base, overall: pointsOf(g, granularity), byMerchant };
}
