import "server-only";

import type { Tx } from "@/db";
import type { Actor } from "@/lib/authz";
import { DEFAULT_TIME_ZONE, localDateOf } from "@/lib/calendar";
import { ConflictError, ValidationError } from "@/lib/errors";
import { inflationWindows, lastMonthsRange } from "@/lib/periods";
import { selectHouseholdTimeZone } from "@/modules/budgets/budgets.repo";
import { type LedgerDeps, inHousehold } from "@/modules/ledger/context";
import { parseInput } from "@/modules/ledger/input";
import { normalizeProductName } from "@/modules/receipts/normalize";

import { DEFAULT_INFLATION_THRESHOLDS, computeInflation } from "./inflation";
import {
  DEFAULT_PRICE_THRESHOLDS,
  type PriceThresholds,
  buildSeries,
  summarizeProducts,
  toObservations,
} from "./prices";
import { TooManyLinesError, selectPriceLines } from "./prices.repo";
import {
  INFLATION_MONTHS_DEFAULT,
  type InflationOutput,
  PRICE_WINDOW_MONTHS_DEFAULT,
  PRODUCTS_LIMIT_DEFAULT,
  type ProductsResult,
  type SeriesResult,
  inflationQuerySchema,
  productsQuerySchema,
  seriesQuerySchema,
  thresholdsOf,
} from "./prices.schema";

/**
 * Prețurile și inflația personală (Faza 10, F10-B; ADR 0023): serviciile peste `prices.repo.ts`
 * (liniile bonurilor confirmate VIZIBILE membrului) și funcțiile pure din `prices.ts` /
 * `inflation.ts`. Totul într-o tranzacție `withMember` (RLS + gospodăria din sesiune); erori cu
 * cod fix, fără ecou din numele produselor sau comercianților.
 */

export type PricesDeps = LedgerDeps & Readonly<{ now?: () => Date }>;

/** Peste plafonul de linii citite: conflict cu cod fix (utilizatorul îngustează perioada). */
export async function guardScan<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof TooManyLinesError) {
      throw new ConflictError(
        "too_many_lines",
        "Sunt prea multe linii de bon pentru perioada aleasă. Alege o perioadă mai scurtă.",
      );
    }
    throw error;
  }
}

export async function householdToday(deps: PricesDeps, tx: Tx, householdId: string) {
  const tz = (await selectHouseholdTimeZone(tx, householdId)) ?? DEFAULT_TIME_ZONE;
  return localDateOf((deps.now ?? (() => new Date()))(), tz);
}

function thresholds(q: Partial<PriceThresholds>): PriceThresholds {
  return { ...DEFAULT_PRICE_THRESHOLDS, ...q };
}

/** Produsele cumpărate, cu prețul mediu și cel mai ieftin comerciant (doar peste prag). */
export async function listProducts(
  deps: PricesDeps,
  actor: Actor,
  householdId: string,
  rawQuery: unknown = {},
): Promise<ProductsResult> {
  const q = parseInput(productsQuerySchema, rawQuery) ?? {};
  const th = thresholds(thresholdsOf(q));
  return guardScan(() =>
    inHousehold(deps, actor, householdId, async (tx, m) => {
      const today = await householdToday(deps, tx, m.householdId);
      const window = lastMonthsRange(q.months ?? PRICE_WINDOW_MONTHS_DEFAULT, today);
      const lines = await selectPriceLines(tx, m.householdId, window);
      const { obs, excluded } = toObservations(lines);
      const needle = q.search === undefined ? null : normalizeProductName(q.search);
      if (q.search !== undefined && q.search.trim() !== "" && needle === null) {
        throw new ValidationError({ search: "Căutare invalidă." });
      }
      let products = summarizeProducts(obs, th);
      if (q.currency) products = products.filter((p) => p.currency === q.currency);
      if (needle) products = products.filter((p) => p.name.includes(needle));
      if (q.onlyEnough) products = products.filter((p) => p.enough);
      return {
        from: window.from!,
        to: window.to!,
        thresholds: th,
        excludedLines: excluded,
        total: products.length,
        products: products.slice(0, q.limit ?? PRODUCTS_LIMIT_DEFAULT),
      };
    }),
  );
}

/** Evoluția prețului unui produs (serie generală + pe comerciant); 404 dacă produsul nu apare. */
export async function getSeries(
  deps: PricesDeps,
  actor: Actor,
  householdId: string,
  rawQuery: unknown,
): Promise<SeriesResult | null> {
  const q = parseInput(seriesQuerySchema, rawQuery);
  const th = thresholds(thresholdsOf(q));
  return guardScan(() =>
    inHousehold(deps, actor, householdId, async (tx, m) => {
      const today = await householdToday(deps, tx, m.householdId);
      const window = lastMonthsRange(q.months ?? PRICE_WINDOW_MONTHS_DEFAULT, today);
      const lines = await selectPriceLines(tx, m.householdId, window);
      const { obs } = toObservations(lines);
      const series = buildSeries(obs, q.product, q.currency ?? "RON", q.granularity ?? "month", th);
      return series === null
        ? null
        : { from: window.from!, to: window.to!, thresholds: th, series };
    }),
  );
}

/** Inflația personală: ultimele `months` luni față de perioada de bază. */
export async function getInflation(
  deps: PricesDeps,
  actor: Actor,
  householdId: string,
  rawQuery: unknown = {},
): Promise<InflationOutput> {
  const q = parseInput(inflationQuerySchema, rawQuery) ?? {};
  const months = q.months ?? INFLATION_MONTHS_DEFAULT;
  const baseline = q.baseline ?? "year_ago";
  const th = {
    ...DEFAULT_INFLATION_THRESHOLDS,
    ...(q.minObservations === undefined ? {} : { minObsPerPeriod: q.minObservations }),
    ...(q.minItems === undefined ? {} : { minItems: q.minItems }),
  };
  return guardScan(() =>
    inHousehold(deps, actor, householdId, async (tx, m) => {
      const today = await householdToday(deps, tx, m.householdId);
      const w = inflationWindows(months, baseline, today);
      // O singură citire pe fereastra care le acoperă pe amândouă (bază ≤ curent).
      const lines = await selectPriceLines(tx, m.householdId, {
        from: w.base.from,
        to: w.current.to,
      });
      const { obs, excluded } = toObservations(lines);
      const inWindow = (r: { from: string; to: string }) =>
        obs.filter((o) => o.occurredOn >= r.from && o.occurredOn <= r.to);
      return {
        months,
        baseline,
        base: w.base,
        current: w.current,
        thresholds: th,
        excludedLines: excluded,
        currencies: computeInflation(inWindow(w.base), inWindow(w.current), th),
      };
    }),
  );
}
