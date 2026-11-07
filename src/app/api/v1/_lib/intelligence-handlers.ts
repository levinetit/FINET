import "server-only";

import type { DbOrTx } from "@/db";
import { type Month, addMonths, isMonth } from "@/lib/calendar";
import { NotFoundError } from "@/lib/authz";
import { ValidationError } from "@/lib/errors";
import { adviceViewToJson } from "@/modules/advisor/advisor.schema";
import { getAdvice } from "@/modules/advisor/advisor.service";
import { type PlanningDeps, resolveMonth } from "@/modules/budgets/budgets.service";
import { forecastViewToJson } from "@/modules/forecast/forecast.schema";
import { getForecast } from "@/modules/forecast/forecast.service";
import { latestRates, ratesToJson } from "@/modules/fx/fx.service";
import { getSavingsPlan, simulateSavings } from "@/modules/goals/plan.service";
import { savingsPlanViewToJson, savingsSimulationToJson } from "@/modules/goals/plan.schema";
import { getSubscriptions } from "@/modules/subscriptions/subscriptions.service";
import { subscriptionsViewToJson } from "@/modules/subscriptions/subscriptions.schema";
import { healthViewToJson } from "@/modules/health/health.schema";
import { getHealthScore } from "@/modules/health/health.service";
import { inHousehold } from "@/modules/ledger/context";

import {
  type ApiContext,
  type ApiDeps,
  currentHousehold,
  handle,
  json,
  readJsonBody,
  readQuery,
} from "./http";

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

/** `GET /api/v1/advisor?month=` — consilierul: tranzacții neobișnuite, tipare, sugestii, pe monedă. */
export function advisorHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { month: "string" });
    const hh = await currentHousehold(ctx);
    const month = await monthOf(ctx, hh, query.month);
    const view = await getAdvice(planning(d.db, ctx), ctx.actor, hh, { month });
    return json({ data: adviceViewToJson(view) });
  });
}

/** `GET /api/v1/savings-plan` — planul obiectivelor active și fondul de urgență, pe monedă. */
export function savingsPlanHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    readQuery(request, {});
    const hh = await currentHousehold(ctx);
    const view = await getSavingsPlan(planning(d.db, ctx), ctx.actor, hh);
    return json({ data: savingsPlanViewToJson(view) });
  });
}

/** `POST /api/v1/savings-plan/simulate` — simulare fără scriere (merge și cu abonament expirat). */
export function simulateSavingsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(
    request,
    d,
    async (ctx) => {
      const body = await readJsonBody(request);
      const hh = await currentHousehold(ctx);
      const sim = await simulateSavings(planning(d.db, ctx), ctx.actor, hh, body);
      return json({ data: savingsSimulationToJson(sim) });
    },
    { allowReadOnly: true },
  );
}

/** `GET /api/v1/subscriptions` — abonamentele (regulile recurente de cheltuieli) și cele detectate. */
export function subscriptionsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    readQuery(request, {});
    const hh = await currentHousehold(ctx);
    const view = await getSubscriptions(planning(d.db, ctx), ctx.actor, hh);
    return json({ data: subscriptionsViewToJson(view) });
  });
}

/** `GET /api/v1/fx/rates?date=` — cursurile BCE cele mai recente (≤ data), baza EUR, ADR 0049. */
export function fxRatesHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { date: "string" });
    await currentHousehold(ctx);
    const date = query.date === undefined ? undefined : String(query.date);
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new ValidationError({ date: "Data trebuie să fie de forma AAAA-LL-ZZ." });
    }
    const table = await latestRates(d.db, date);
    if (!table) throw new NotFoundError();
    return json({ data: ratesToJson(table) });
  });
}
