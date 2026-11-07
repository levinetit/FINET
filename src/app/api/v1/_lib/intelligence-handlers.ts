import "server-only";

import type { DbOrTx } from "@/db";
import { type Month, addMonths, isMonth } from "@/lib/calendar";
import { ValidationError } from "@/lib/errors";
import { type PlanningDeps, resolveMonth } from "@/modules/budgets/budgets.service";
import { forecastViewToJson } from "@/modules/forecast/forecast.schema";
import { getForecast } from "@/modules/forecast/forecast.service";
import { healthViewToJson } from "@/modules/health/health.schema";
import { getHealthScore } from "@/modules/health/health.service";
import { inHousehold } from "@/modules/ledger/context";

import { type ApiContext, type ApiDeps, currentHousehold, handle, json, readQuery } from "./http";

/**
 * Handlerele „inteligenței financiare” (modernizare 2026, pașii D–F; ADR 0045): scorul de sănătate,
 * prognoza de cash-flow și consilierul. Toate sunt CITIRI (GET) peste agregatele existente, fără
 * migrații; aceleași reguli ca planificarea (ADR 0005/0007): sesiune, gospodăria din bază, luna
 * validată în fereastra de 60 de luni, 404 uniform, răspunsuri verificate față de OpenAPI.
 */

const MONTH_WINDOW_BACK = 60;

function planning(db: DbOrTx, ctx: ApiContext): PlanningDeps {
  return { db, now: () => new Date(ctx.now) };
}

async function monthOf(ctx: ApiContext, householdId: string, raw: unknown): Promise<Month> {
  const current = await inHousehold({ db: ctx.deps.db }, ctx.actor, householdId, (tx, m) =>
    resolveMonth(tx, m.householdId, undefined, () => new Date(ctx.now)),
  );
  if (raw === undefined) return current;
  if (!isMonth(raw)) {
    throw new ValidationError({ month: "Luna trebuie să fie de forma AAAA-LL." });
  }
  if (raw > current || raw < addMonths(current, -MONTH_WINDOW_BACK)) {
    throw new ValidationError({
      month: `Luna trebuie să fie între ultimele ${MONTH_WINDOW_BACK} de luni și luna curentă.`,
    });
  }
  return raw;
}

/** `GET /api/v1/health-score?month=` — scorul de sănătate financiară, pe monedă. */
export function healthScoreHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { month: "string" });
    const hh = await currentHousehold(ctx);
    const month = await monthOf(ctx, hh, query.month);
    const view = await getHealthScore(planning(d.db, ctx), ctx.actor, hh, { month });
    return json({ data: healthViewToJson(view) });
  });
}

/** `GET /api/v1/forecast?days=30|60|90` — prognoza de cash-flow, pe monedă (implicit 90 de zile). */
export function forecastHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { days: "int" });
    const hh = await currentHousehold(ctx);
    const view = await getForecast(planning(d.db, ctx), ctx.actor, hh, {
      ...(query.days === undefined ? {} : { days: query.days }),
    });
    return json({ data: forecastViewToJson(view) });
  });
}
