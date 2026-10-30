import type { Currency } from "@/lib/money";

import { type PriceObs, weightedPrice } from "./prices";
import { type UnitDimension, divRoundHalfAway } from "./units";

/**
 * Inflația personală (Faza 10, F10-B; ADR 0023): variația prețului mediu pe unitate între două
 * perioade, DOAR pentru ce ai cumpărat în ambele perioade, de la același comerciant. Funcții PURE
 * pe `bigint`; o ESTIMARE din bonurile tale, nu un indice oficial.
 *
 * Formula (per monedă):
 * - un **articol** = (produs, comerciant); intră doar dacă are cel puțin `minObsPerPeriod`
 *   observații în FIECARE perioadă (prețul = media ponderată cu cantitatea din `prices.ts`);
 * - variația articolului: `r_i = P1_i / P0_i` (P0 = perioada de bază, P1 = perioada curentă);
 * - agregatul gospodăriei, ponderat cu CHELTUIALA din perioada de bază `w_i = Σ total_i(bază)`:
 *   `I = Σ w_i · r_i / Σ w_i − 1`;
 * - rezultatul se dă în puncte de bază (1 pb = 0,01 %), rotunjit jumătate dinspre zero; rapoartele
 *   se calculează cu 9 zecimale pe `bigint` (fără float);
 * - afișat doar cu cel puțin `minItems` articole (și, pe comerciant, `minMerchantItems`); acoperirea
 *   (`coverageBps`) = ponderea cheltuielii de bază acoperite de articolele folosite din toată
 *   cheltuiala de bază a monedei.
 * Nu se amestecă monede; liniile fără comerciant nu intră (nu știm dacă e același magazin).
 */

export const INFLATION_MIN_OBS_PER_PERIOD = 2;
export const INFLATION_MIN_ITEMS = 5;
export const INFLATION_MIN_MERCHANT_ITEMS = 3;
const MAX_ITEMS_LISTED = 100;

export type InflationThresholds = Readonly<{
  minObsPerPeriod: number;
  minItems: number;
  minMerchantItems: number;
}>;

export const DEFAULT_INFLATION_THRESHOLDS: InflationThresholds = {
  minObsPerPeriod: INFLATION_MIN_OBS_PER_PERIOD,
  minItems: INFLATION_MIN_ITEMS,
  minMerchantItems: INFLATION_MIN_MERCHANT_ITEMS,
};

export type InflationItem = Readonly<{
  productKey: string;
  name: string;
  unit: UnitDimension;
  merchantKey: string;
  merchantName: string | null;
  baseObservations: number;
  currentObservations: number;
  basePriceMinor: bigint;
  currentPriceMinor: bigint;
  /** Cheltuiala din perioada de bază pe acest articol (ponderea). */
  baseSpendMinor: bigint;
  changeBps: bigint;
}>;

export type InflationMerchant = Readonly<{
  merchantKey: string;
  merchantName: string | null;
  items: number;
  /** `null` sub pragul pe comerciant. */
  changeBps: bigint | null;
}>;

export type InflationResult = Readonly<{
  currency: Currency;
  /** `ok` = variația gospodăriei se poate afișa; `insufficient` = prea puține articole comune. */
  status: "ok" | "insufficient";
  itemsUsed: number;
  coverageBps: bigint;
  changeBps: bigint | null;
  byMerchant: readonly InflationMerchant[];
  /** Cele mai mari variații (în valoare absolută), cel mult 100. */
  items: readonly InflationItem[];
}>;

const SCALE = 1_000_000_000n;
const BPS_STEP = SCALE / 10_000n; // 100 000

const abs = (n: bigint) => (n < 0n ? -n : n);

/** Variația ponderată, în pb, a unei liste de articole (spre `null` dacă ponderea e 0). */
export function weightedChangeBps(
  items: ReadonlyArray<
    Pick<InflationItem, "basePriceMinor" | "currentPriceMinor" | "baseSpendMinor">
  >,
): bigint | null {
  let num = 0n;
  let den = 0n;
  for (const i of items) {
    const ratio = divRoundHalfAway(i.currentPriceMinor * SCALE, i.basePriceMinor);
    num += i.baseSpendMinor * ratio;
    den += i.baseSpendMinor;
  }
  if (den === 0n) return null;
  const agg = divRoundHalfAway(num, den);
  return divRoundHalfAway(agg - SCALE, BPS_STEP);
}

const key = (o: PriceObs) => `${o.currency}\u0000${o.productKey}\u0000${o.merchantKey}`;

function groupItems(obs: readonly PriceObs[]): Map<string, PriceObs[]> {
  const m = new Map<string, PriceObs[]>();
  for (const o of obs) {
    if (o.merchantKey === null) continue;
    const k = key(o);
    const g = m.get(k);
    if (g) g.push(o);
    else m.set(k, [o]);
  }
  return m;
}

export function computeInflation(
  baseObs: readonly PriceObs[],
  currentObs: readonly PriceObs[],
  thresholds: InflationThresholds = DEFAULT_INFLATION_THRESHOLDS,
): InflationResult[] {
  const base = groupItems(baseObs);
  const current = groupItems(currentObs);
  // Cheltuiala totală de bază pe monedă (toate liniile cu comerciant), pentru acoperire.
  const spendByCurrency = new Map<Currency, bigint>();
  for (const g of base.values()) {
    const c = g[0]!.currency;
    spendByCurrency.set(
      c,
      (spendByCurrency.get(c) ?? 0n) + g.reduce((s, o) => s + o.totalMinor, 0n),
    );
  }
  const itemsByCurrency = new Map<Currency, InflationItem[]>();
  for (const [k, b] of base) {
    const c = current.get(k);
    if (!c) continue;
    if (b.length < thresholds.minObsPerPeriod || c.length < thresholds.minObsPerPeriod) continue;
    const p0 = weightedPrice(b);
    const p1 = weightedPrice(c);
    if (p0 === null || p1 === null || p0 <= 0n || p1 <= 0n) continue;
    const first = b[0]!;
    const last = c.reduce((a, o) => (o.occurredOn > a.occurredOn ? o : a));
    const item: InflationItem = {
      productKey: first.productKey,
      name: first.name,
      unit: first.unit,
      merchantKey: first.merchantKey!,
      merchantName: last.merchantName ?? first.merchantName,
      baseObservations: b.length,
      currentObservations: c.length,
      basePriceMinor: p0,
      currentPriceMinor: p1,
      baseSpendMinor: b.reduce((s, o) => s + o.totalMinor, 0n),
      changeBps: divRoundHalfAway(divRoundHalfAway(p1 * SCALE, p0) - SCALE, BPS_STEP),
    };
    const list = itemsByCurrency.get(first.currency);
    if (list) list.push(item);
    else itemsByCurrency.set(first.currency, [item]);
  }
  const currencies = new Set<Currency>([...spendByCurrency.keys(), ...itemsByCurrency.keys()]);
  const out: InflationResult[] = [];
  for (const currency of [...currencies].sort()) {
    const items = itemsByCurrency.get(currency) ?? [];
    const enough = items.length >= thresholds.minItems;
    const used = items.reduce((s, i) => s + i.baseSpendMinor, 0n);
    const total = spendByCurrency.get(currency) ?? 0n;
    const merchants = new Map<string, InflationItem[]>();
    for (const i of items) {
      const g = merchants.get(i.merchantKey);
      if (g) g.push(i);
      else merchants.set(i.merchantKey, [i]);
    }
    const byMerchant: InflationMerchant[] = enough
      ? [...merchants.entries()]
          .map(([merchantKey, g]) => ({
            merchantKey,
            merchantName: g[0]!.merchantName,
            items: g.length,
            changeBps: g.length >= thresholds.minMerchantItems ? weightedChangeBps(g) : null,
          }))
          .sort((a, b) => b.items - a.items || a.merchantKey.localeCompare(b.merchantKey))
      : [];
    out.push({
      currency,
      status: enough ? "ok" : "insufficient",
      itemsUsed: items.length,
      coverageBps: total > 0n ? divRoundHalfAway(used * 10_000n, total) : 0n,
      changeBps: enough ? weightedChangeBps(items) : null,
      byMerchant,
      // Articolele individuale apar doar când agregatul e afișabil (același prag de date).
      items: enough
        ? [...items]
            .sort((a, b) =>
              abs(b.changeBps) !== abs(a.changeBps)
                ? abs(b.changeBps) > abs(a.changeBps)
                  ? 1
                  : -1
                : a.name.localeCompare(b.name, "ro"),
            )
            .slice(0, MAX_ITEMS_LISTED)
        : [],
    });
  }
  return out;
}
