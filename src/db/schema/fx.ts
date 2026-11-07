import { sql } from "drizzle-orm";
import { bigint, check, date, index, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { finet } from "./finet";

/**
 * Modernizare 2026 — cursurile valutare (ADR 0049). Date de referință GLOBALE (fără gospodărie),
 * din cursurile zilnice ale Băncii Centrale Europene (baza EUR): `rate_micro` = câte unități din
 * monedă pentru 1 EUR, înmulțit cu 1.000.000 (întreg; BCE publică cel mult 5 zecimale). EUR nu se
 * stochează (1.000.000 implicit). Scrise de worker, citite de toată lumea; conversia e DOAR pentru
 * afișare (`src/lib/fx.ts`), niciodată pentru sume stocate.
 *
 * Migrația: `src/db/migrations/0029_currencies.sql` (DDL-ul de aici, generat, plus CHECK-urile de
 * monedă rescrise pentru HUF și GBP, RLS și drepturile).
 */

export const FX_BASE = "EUR";
export const FX_MICRO = 1_000_000n;
export const FX_SOURCES = ["ecb"] as const;

export const fxRates = finet.table(
  "fx_rates",
  {
    rateDate: date("rate_date", { mode: "string" }).notNull(),
    currency: text("currency").notNull(),
    rateMicro: bigint("rate_micro", { mode: "bigint" }).notNull(),
    source: text("source", { enum: FX_SOURCES }).notNull().default("ecb"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "fx_rates_pkey", columns: [t.rateDate, t.currency] }),
    index("fx_rates_currency_date_idx").on(t.currency, t.rateDate),
    check("fx_rates_currency_valid", sql`${t.currency} in ('RON', 'USD', 'HUF', 'GBP')`),
    check("fx_rates_rate_range", sql`${t.rateMicro} between 1 and 1000000000000`),
    check("fx_rates_source_valid", sql`${t.source} in ('ecb')`),
    check("fx_rates_date_range", sql`${t.rateDate} between '1999-01-04' and '2999-12-31'`),
  ],
);
