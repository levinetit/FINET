import "server-only";

import { getConfig } from "@/lib/config";
import { askFinet } from "@/modules/ask/ask.service";
import { type AskAi, askAiFromConfig } from "@/modules/ask/ask-runtime";
import { createEntitlements } from "@/modules/entitlements";

import {
  type ApiDeps,
  ApiError,
  currentHousehold,
  enforceRateLimit,
  json,
  readJsonBody,
  handleAlways,
} from "./http";

/**
 * „Întreabă FINET” (Faza 10, F10-C; ADR 0025): `POST /api/v1/ask` cu `{ question }`. Citire pură
 * (nu modifică nimic), dar întrebarea e în corp, nu în adresă: ca să nu ajungă în jurnalele de
 * acces. Limită proprie (`ask`), funcția trece prin `entitlements` (în `saas`, legată de plan),
 * gospodăria vine din sesiune. Textul întrebării nu se păstrează nicăieri.
 */
/**
 * Funcția `ask.finet` după plan. În `personal` e mereu permisă. În `saas` o decide planul
 * efectiv al gospodăriei (Faza 12-A): fără plan, cu abonament expirat sau fără funcția în plan,
 * răspunsul e `false` (FAIL CLOSED).
 */
function allowed(householdId: string, d: ApiDeps): Promise<boolean> {
  return createEntitlements(d.config.appMode, d.config, d.db).can(householdId, "ask.finet");
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
  return handleAlways(request, d, async (ctx) => {
    const body = await readJsonBody(request);
    await enforceRateLimit(ctx, "api_ask", ctx.limits.ask);
    const hh = await currentHousehold(ctx);
    if (!(await allowed(hh, d))) {
      throw new ApiError(403, "forbidden", "Funcția nu e disponibilă în planul curent.");
    }
    const result = await askFinet({ db: d.db, now: () => new Date(ctx.now) }, ctx.actor, hh, body, {
      ai: askAiOf(d),
    });
    return json({ data: result });
  });
}
