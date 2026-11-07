import "server-only";

import { and, desc, eq, lte, sql } from "drizzle-orm";

import type { DbOrTx } from "@/db";
import { fxRates } from "@/db/schema";
import { FX_BASE, FX_MICRO, type RateTable } from "@/lib/fx";
import { CURRENCIES, type Currency, isCurrency } from "@/lib/money";

import { ECB_DAILY_URL, ECB_HISTORY_URL, type EcbRate, fetchEcb, parseEcbXml } from "./ecb";

/**
 * Cursurile valutare (ADR 0049): citirea tabelei `fx_rates` (globală, sub politica de citire
 * pentru orice utilizator autentificat sau pentru worker) și reîmprospătarea din BCE (doar worker,
 * `FX_RATES=1`). Tabelul se umple la prima rulare cu istoricul pe 90 de zile, apoi zilnic.
 */

export const FX_MAX_HISTORY_DAYS = 90;

/** Cursurile cele mai recente cu `rate_date ≤ onOrBefore` (sau cele mai recente de tot). */
export async function latestRates(db: DbOrTx, onOrBefore?: string): Promise<RateTable | null> {
  const conds = onOrBefore ? [lte(fxRates.rateDate, onOrBefore)] : [];
  const [latest] = await db
    .select({ date: fxRates.rateDate })
    .from(fxRates)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(fxRates.rateDate))
    .limit(1);
  if (!latest) return null;
  const rows = await db
    .select({ currency: fxRates.currency, rateMicro: fxRates.rateMicro })
    .from(fxRates)
    .where(eq(fxRates.rateDate, latest.date));
  const rates = new Map<Currency, bigint>();
  for (const r of rows) if (isCurrency(r.currency)) rates.set(r.currency, r.rateMicro);
  rates.set(FX_BASE, FX_MICRO);
  return { date: latest.date, rates };
}

export type RatesJson = Readonly<{
  base: typeof FX_BASE;
  date: string;
  /** Monedă → `rateMicro` ca întreg JSON (curs × 1.000.000). */
  rates: Readonly<Record<string, number>>;
}>;

export function ratesToJson(table: RateTable): RatesJson {
  const rates: Record<string, number> = {};
  for (const c of CURRENCIES) {
    const r = table.rates.get(c);
    if (r !== undefined) rates[c] = Number(r);
  }
  return { base: FX_BASE, date: table.date, rates };
}

export async function upsertRates(
  db: DbOrTx,
  rows: readonly EcbRate[],
  now: Date,
): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(fxRates)
    .values(
      rows.map((r) => ({
        rateDate: r.date,
        currency: r.currency,
        rateMicro: r.rateMicro,
        source: "ecb" as const,
        fetchedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [fxRates.rateDate, fxRates.currency],
      set: { rateMicro: sql`excluded.rate_micro`, fetchedAt: now },
    })
    .returning({ date: fxRates.rateDate });
  return inserted.length;
}

export async function countRates(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(fxRates);
  return Number(row?.n ?? 0);
}

export type RefreshDeps = Readonly<{
  db: DbOrTx;
  now?: () => Date;
  /** Descărcarea (injectabilă în teste); implicit `fetchEcb`. */
  download?: (url: string) => Promise<string>;
}>;

export type RefreshResult = Readonly<{
  source: "daily" | "history";
  parsed: number;
  upserted: number;
}>;

/** Prima rulare (tabel gol) ia istoricul pe 90 de zile; apoi doar ziua curentă a BCE. */
export async function refreshRates(deps: RefreshDeps): Promise<RefreshResult> {
  const download = deps.download ?? ((url: string) => fetchEcb(url));
  const now = (deps.now ?? (() => new Date()))();
  const empty = (await countRates(deps.db)) === 0;
  const url = empty ? ECB_HISTORY_URL : ECB_DAILY_URL;
  const rows = parseEcbXml(await download(url));
  const upserted = await upsertRates(deps.db, rows, now);
  return { source: empty ? "history" : "daily", parsed: rows.length, upserted };
}
