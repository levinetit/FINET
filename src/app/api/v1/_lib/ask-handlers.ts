import "server-only";

import { NotImplementedError } from "@/lib/errors";
import { getConfig } from "@/lib/config";
import { askFinet } from "@/modules/ask/ask.service";
import { type AskAi, askAiFromConfig } from "@/modules/ask/ask-runtime";
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
/**
 * Funcția `ask.finet` după plan. În `personal` e mereu permisă. În `saas` implementarea
 * `entitlements` vine în Faza 12 (până atunci aruncă `NotImplementedError`): până atunci funcția
 * rămâne permisă (nu există planuri de refuzat), iar o implementare reală poate răspunde `false`.
 */
async function allowed(householdId: string): Promise<boolean> {
  try {
    return await can(householdId, "ask.finet");
  } catch (error) {
    if (error instanceof NotImplementedError) return true;
    throw error;
  }
}

let configured: { key: unknown; ai: AskAi | null } | null = null;

/** Furnizorul AI al web-ului: injectat în teste, altfel din configurație (memorat; `null` dacă e oprit). */
function askAiOf(d: ApiDeps): AskAi | null {
  if (d.ask !== undefined) return d.ask.ai;
  const config = getConfig();
  if (configured?.key !== config) configured = { key: config, ai: askAiFromConfig(config) };
  return configured.ai;
}

export function askHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const body = await readJsonBody(request);
    await enforceRateLimit(ctx, "api_ask", ctx.limits.ask);
    const hh = await currentHousehold(ctx);
    if (!(await allowed(hh))) {
      throw new ApiError(403, "forbidden", "Funcția nu e disponibilă în planul curent.");
    }
    const result = await askFinet({ db: d.db, now: () => new Date(ctx.now) }, ctx.actor, hh, body, {
      ai: askAiOf(d),
    });
    return json({ data: result });
  });
}
