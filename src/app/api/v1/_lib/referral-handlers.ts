import "server-only";

import { NotFoundError } from "@/lib/authz";
import { myReferral } from "@/modules/referrals/referrals.service";

import { type ApiDeps, handleAlways, json, readQuery } from "./http";

/**
 * Recomandările (Faza 12-C, ADR 0037): DOAR `saas` (404 în `personal`). Fără `userId` în cerere.
 * Citirea creează codul propriu la prima cerere; nu scrie nimic financiar și nu e blocată de un
 * abonament expirat (`handleAlways`).
 */
export function meReferralHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handleAlways(request, d, async (ctx) => {
    if (d.config.appMode !== "saas") throw new NotFoundError();
    readQuery(request, {});
    const me = await myReferral(d.db, ctx.actor.userId);
    const origin = new URL(d.config.appUrl ?? "http://localhost:3000").origin;
    return json({
      data: { ...me, link: me.code ? `${origin}/ref/${me.code}` : null },
    });
  });
}
