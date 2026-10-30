import "server-only";

import { askFinet } from "@/modules/ask/ask.service";
import { can } from "@/modules/entitlements";

import {
  type ApiDeps,
  ApiError,
  currentHousehold,
  enforceRateLimit,
  handle,
  json,
  readJsonBody,
} from "./http";

/**
 * „Întreabă FINET” (Faza 10, F10-C; ADR 0025): `POST /api/v1/ask` cu `{ question }`. Citire pură
 * (nu modifică nimic), dar întrebarea e în corp, nu în adresă: ca să nu ajungă în jurnalele de
 * acces. Limită proprie (`ask`), funcția trece prin `entitlements` (în `saas`, legată de plan),
 * gospodăria vine din sesiune. Textul întrebării nu se păstrează nicăieri.
 */
export function askHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const body = await readJsonBody(request);
    await enforceRateLimit(ctx, "api_ask", ctx.limits.ask);
    const hh = await currentHousehold(ctx);
    if (!(await can(hh, "ask.finet"))) {
      throw new ApiError(403, "forbidden", "Funcția nu e disponibilă în planul curent.");
    }
    const result = await askFinet({ db: d.db, now: () => new Date(ctx.now) }, ctx.actor, hh, body);
    return json({ data: result });
  });
}
