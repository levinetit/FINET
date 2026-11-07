import "server-only";

import type { DbOrTx } from "@/db";
import type { PlanningDeps } from "@/modules/budgets/budgets.service";
import { netWorthViewToJson, valuationToJson } from "@/modules/net-worth/net-worth.schema";
import {
  addValuation,
  deleteValuation,
  getNetWorth,
  listValuations,
} from "@/modules/net-worth/net-worth.service";

import {
  type ApiContext,
  type ApiDeps,
  currentHousehold,
  handle,
  idempotentCreate,
  json,
  readJsonBody,
  readQuery,
  routeId,
} from "./http";

/**
 * Averea netă și evaluările conturilor (modernizare 2026, pasul G; ADR 0046). Aceleași reguli ca
 * registrul (ADR 0005): sesiune, gospodăria din bază, Zod strict în serviciu, 404 uniform,
 * `Idempotency-Key` opțional pe crearea evaluării, rate limiting pe mutații.
 */

function planning(db: DbOrTx, ctx: ApiContext): PlanningDeps {
  return { db, now: () => new Date(ctx.now) };
}

/** `GET /api/v1/net-worth?months=` — averea netă curentă și istoricul lunar, pe monedă. */
export function netWorthHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { months: "int" });
    const hh = await currentHousehold(ctx);
    const view = await getNetWorth(planning(d.db, ctx), ctx.actor, hh, {
      ...(query.months === undefined ? {} : { months: query.months }),
    });
    return json({ data: netWorthViewToJson(view) });
  });
}

/** `GET /api/v1/accounts/{id}/valuations` — evaluările contului, cele mai noi primele. */
export function listValuationsHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const accountId = routeId(id);
    const hh = await currentHousehold(ctx);
    const list = await listValuations({ db: d.db }, ctx.actor, hh, accountId);
    return json({ data: list.map(valuationToJson) });
  });
}

/** `POST /api/v1/accounts/{id}/valuations` — o evaluare nouă (`Idempotency-Key` opțional). */
export function createValuationHandler(
  request: Request,
  d: ApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const accountId = routeId(id);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    return idempotentCreate(ctx, hh, body, async (db) => ({
      status: 201,
      body: {
        data: valuationToJson(
          await addValuation(planning(db, ctx), ctx.actor, hh, accountId, body),
        ),
      },
    }));
  });
}

/** `DELETE /api/v1/accounts/{id}/valuations/{valuationId}` — șterge o evaluare. */
export function deleteValuationHandler(
  request: Request,
  d: ApiDeps,
  id: string,
  valuationId: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const accountId = routeId(id);
    const vid = routeId(valuationId);
    const hh = await currentHousehold(ctx);
    await deleteValuation({ db: d.db }, ctx.actor, hh, accountId, vid);
    return json(null, 204);
  });
}
