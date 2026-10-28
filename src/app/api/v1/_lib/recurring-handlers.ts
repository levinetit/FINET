import "server-only";

import { z } from "zod";

import { ValidationError } from "@/lib/errors";
import { insertAudit } from "@/modules/auth/audit";
import { inHousehold } from "@/modules/ledger/context";
import { recurringRuleToJson } from "@/modules/recurring/recurring.schema";
import {
  createRecurringRule,
  deleteRecurringRule,
  generateDueForHousehold,
  getRecurringRule,
  listRecurringRules,
  pauseRecurringRule,
  resumeRecurringRule,
  todayLocal,
  updateRecurringRule,
} from "@/modules/recurring/recurring.service";

import {
  type ApiContext,
  type ApiDeps,
  currentHousehold,
  enforceRateLimit,
  handle,
  idempotencyKeyOf,
  idempotentCreate,
  json,
  parseWith,
  readJsonBody,
  readOptionalJsonBody,
  readQuery,
  routeId,
} from "./http";

/**
 * Handlerele plăților recurente (Faza 5, F5-B; ADR 0011, 0012). Aceleași reguli ca registrul
 * (ADR 0005): sesiune, CSRF pe mutațiile cu cookie, gospodăria din sesiune/bază (niciodată din
 * corp), Zod strict în servicii, 404 uniform, `Idempotency-Key` pe creare, rate limiting.
 *
 * „Azi” = data locală din București (`Europe/Bucharest`) la momentul CERERII (ceasul injectat):
 * nu se primește din cerere. Fusul gospodăriei nu e folosit încă (ADR 0011, „Rămân deschise”).
 */

const noBody = () => json(null, 204);

const todayOf = (ctx: ApiContext): string => todayLocal(new Date(ctx.now));

export function listRecurringHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { status: "string" });
    const hh = await currentHousehold(ctx);
    const list = await listRecurringRules({ db: d.db }, ctx.actor, hh, query, todayOf(ctx));
    return json({ data: list.data.map(recurringRuleToJson), counts: list.counts });
  });
}

/**
 * Contorul paginii: `active` (reguli active), `due` (reguli active cu o scadență negenerată ≤ azi —
 * „reguli scadente”, NU numărul de ocurențe în așteptare) și `total`.
 */
export function recurringSummaryHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    readQuery(request, {});
    const hh = await currentHousehold(ctx);
    const list = await listRecurringRules({ db: d.db }, ctx.actor, hh, {}, todayOf(ctx));
    return json({ data: list.counts });
  });
}

export function createRecurringHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    return idempotentCreate(ctx, hh, body, async (db) => ({
      status: 201,
      body: {
        data: recurringRuleToJson(
          await createRecurringRule({ db }, ctx.actor, hh, body, todayOf(ctx)),
        ),
      },
    }));
  });
}

export function getRecurringHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const ruleId = routeId(id);
    const hh = await currentHousehold(ctx);
    const view = await getRecurringRule({ db: d.db }, ctx.actor, hh, ruleId, todayOf(ctx));
    return json({ data: recurringRuleToJson(view) });
  });
}

export function patchRecurringHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const ruleId = routeId(id);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    const view = await updateRecurringRule({ db: d.db }, ctx.actor, hh, ruleId, body, todayOf(ctx));
    return json({ data: recurringRuleToJson(view) });
  });
}

/** Ștergere definitivă (auditată fără sume); tranzacțiile generate rămân. */
export function deleteRecurringHandler(
  request: Request,
  d: ApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const ruleId = routeId(id);
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    await deleteRecurringRule({ db: d.db }, ctx.actor, hh, ruleId);
    return noBody();
  });
}

/** Corpul opțional al acțiunilor (`pause`, `resume`, `generate`): gol sau `{}`. */
const emptyBody = z.strictObject({});

export function pauseRecurringHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const ruleId = routeId(id);
    parseWith(emptyBody, (await readOptionalJsonBody(request)) ?? {});
    const hh = await currentHousehold(ctx);
    const view = await pauseRecurringRule({ db: d.db }, ctx.actor, hh, ruleId, todayOf(ctx));
    return json({ data: recurringRuleToJson(view) });
  });
}

/** Reluarea: fără generarea retroactivă a scadențelor sărite (prima scadență ≥ azi). */
export function resumeRecurringHandler(
  request: Request,
  d: ApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const ruleId = routeId(id);
    parseWith(emptyBody, (await readOptionalJsonBody(request)) ?? {});
    const hh = await currentHousehold(ctx);
    const view = await resumeRecurringRule({ db: d.db }, ctx.actor, hh, ruleId, todayOf(ctx));
    return json({ data: recurringRuleToJson(view) });
  });
}

/**
 * „Generează scadentele” pentru gospodăria curentă, ca utilizatorul curent (RLS), DIRECT prin
 * serviciu (decizia coordonatorului: serverul web nu depinde de pg-boss). `Idempotency-Key` e
 * OBLIGATORIU (ca la contribuții): o reîncercare cu aceeași cheie întoarce același răspuns, iar
 * generarea e oricum idempotentă pe ocurență (`(rule_id, occurrence_date)`), deci o a doua cheie
 * creează 0 tranzacții noi. Limita proprie, mai strânsă, se aplică înaintea oricărei interogări a
 * datelor. Auditul (`recurring.generated`) are doar contoare, fără sume, reguli sau descrieri.
 */
export function generateRecurringHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const body = parseWith(emptyBody, (await readOptionalJsonBody(request)) ?? {});
    if (idempotencyKeyOf(request) === null) {
      throw new ValidationError(
        { "Idempotency-Key": "Antetul Idempotency-Key e obligatoriu pentru generare." },
        "Antetul Idempotency-Key lipsește.",
      );
    }
    await enforceRateLimit(ctx, "api_recurring_generate", ctx.limits.recurringGenerate);
    const hh = await currentHousehold(ctx);
    const today = todayOf(ctx);
    return idempotentCreate(ctx, hh, body, async (db) => {
      const s = await generateDueForHousehold({ db }, ctx.actor, hh, today);
      await inHousehold({ db }, ctx.actor, hh, (tx, m) =>
        insertAudit(tx, ctx.actor.userId, m.householdId, {
          action: "recurring.generated",
          targetType: "household",
          targetId: m.householdId,
          metadata: {
            rules: s.rules,
            generated: s.generated,
            failed: s.failed,
            skipped: s.skipped,
          },
        }),
      );
      return {
        status: 200,
        body: {
          data: {
            today,
            rules: s.rules,
            generated: s.generated,
            failed: s.failed,
            skipped: s.skipped,
          },
        },
      };
    });
  });
}
