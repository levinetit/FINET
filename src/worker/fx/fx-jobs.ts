import "server-only";

import type { Db } from "@/db";
import { type RefreshResult, refreshRates } from "@/modules/fx/fx.service";
import type { LogFn } from "@/worker/jobs";

/**
 * Jobul cursurilor valutare (ADR 0049): descarcă XML-ul BCE și face upsert în `fx_rates`.
 * Zilnic la 17:30 Europe/Bucharest (BCE publică în jurul orei 16:00 CET) și o dată la pornirea
 * workerului (ca un tabel gol să se umple fără să aștepte până a doua zi). Loguri: doar contoare.
 */

export const JOB_FX_REFRESH = "fx.refresh";
export const FX_CRON = "30 17 * * *";

export type FxJobDeps = Readonly<{
  db: Db;
  log?: LogFn;
  now?: () => Date;
  download?: (url: string) => Promise<string>;
}>;

export async function handleFxRefresh(deps: FxJobDeps): Promise<RefreshResult> {
  const r = await refreshRates({ db: deps.db, now: deps.now, download: deps.download });
  deps.log?.({ job: JOB_FX_REFRESH, source: r.source, parsed: r.parsed, upserted: r.upserted });
  return r;
}
