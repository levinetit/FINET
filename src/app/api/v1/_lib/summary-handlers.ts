import "server-only";

import { getMonthlySummary } from "@/modules/summary/summary.service";

import { type ApiDeps, currentHousehold, handle, json, readQuery } from "./http";

/** Rezumatul lunii (F10-C; ADR 0025): `GET /api/v1/summary/monthly?month=`. Citire pură. */
export function monthlySummaryHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { month: "string" });
    const hh = await currentHousehold(ctx);
    const summary = await getMonthlySummary(
      { db: d.db, now: () => new Date(ctx.now) },
      ctx.actor,
      hh,
      query.month === undefined ? {} : { month: query.month },
    );
    return json({ data: summary });
  });
}
