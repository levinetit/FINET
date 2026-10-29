import "server-only";

import { type Currency, money, toJson } from "@/lib/money";
import {
  type ReceiptMatches,
  decideReceiptMatch,
  getReceiptMatches,
  listMatchQueue,
} from "@/modules/matching/matching.service";
import { recurringRuleToJson } from "@/modules/recurring/recurring.schema";
import {
  type SuggestionView,
  acceptRecurringSuggestion,
  dismissRecurringSuggestion,
  listRecurringSuggestions,
} from "@/modules/recurring/suggestions.service";

import {
  type ApiDeps,
  currentHousehold,
  handle,
  idempotentCreate,
  json,
  readJsonBody,
  readOptionalJsonBody,
  readQuery,
  routeId,
} from "./http";
import { householdAudience, notifyLive } from "./live";

/**
 * Handlerele potrivirii bon ↔ tranzacție și ale propunerilor de plăți recurente (Faza 7, F7-B;
 * ADR 0019). Sub RLS-ul membrului: tranzacțiile și propunerile din conturile PERSONALE ale altor
 * membri nu apar și nu se pot alege (404 uniform). Deciziile sunt idempotente; acceptarea unei
 * propuneri acceptă `Idempotency-Key` (creează o regulă).
 */

const minor = (v: bigint, c: string) => toJson(money(v, c as Currency)).amountMinor;

export function matchesToJson(m: ReceiptMatches) {
  return {
    receiptId: m.receiptId,
    status: m.status,
    merchantName: m.merchantName,
    occurredOn: m.occurredOn,
    totalMinor: minor(m.totalMinor, m.currency),
    currency: m.currency,
    ambiguous: m.ambiguous,
    candidates: m.candidates.map((c) => ({
      transactionId: c.transactionId,
      accountId: c.accountId,
      occurredOn: c.occurredOn,
      amountMinor: minor(c.amountMinor, c.currency),
      currency: c.currency,
      description: c.description,
      score: c.score,
      probable: c.probable,
      reasons: [...c.reasons],
    })),
  };
}

export function suggestionToJson(s: SuggestionView) {
  return {
    signature: s.signature,
    accountId: s.accountId,
    accountName: s.accountName,
    type: s.type,
    currency: s.currency,
    description: s.description,
    merchant: s.merchant,
    categoryId: s.categoryId,
    frequency: s.frequency,
    amountMinor: minor(s.amountMinor, s.currency),
    occurrences: s.occurrences,
    lastOn: s.lastOn,
    nextOn: s.nextOn,
  };
}

/** Sugestiile pentru un bon (`null` = bonul nu e eligibil: fără total/dată sau deja potrivit). */
export function receiptMatchesHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const receiptId = routeId(id);
    readQuery(request, {});
    const hh = await currentHousehold(ctx);
    const m = await getReceiptMatches({ db: d.db }, ctx.actor, hh, receiptId);
    return json({ data: m ? matchesToJson(m) : null });
  });
}

export function decideMatchHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const receiptId = routeId(id);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    const r = await decideReceiptMatch({ db: d.db }, ctx.actor, hh, receiptId, body);
    if (r.decision === "confirm") notifyLive(hh, "receipt", r.receiptId, householdAudience());
    return json({ data: r });
  });
}

export function matchQueueHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const raw = readQuery(request, { limit: "int" });
    const hh = await currentHousehold(ctx);
    const list = await listMatchQueue({ db: d.db }, ctx.actor, hh, raw);
    return json({ data: list.map(matchesToJson) });
  });
}

export function listSuggestionsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    readQuery(request, {});
    const hh = await currentHousehold(ctx);
    const now = () => new Date(ctx.now);
    const list = await listRecurringSuggestions({ db: d.db, now }, ctx.actor, hh);
    return json({ data: list.map(suggestionToJson) });
  });
}

export function acceptSuggestionHandler(
  request: Request,
  d: ApiDeps,
  signature: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const body = (await readOptionalJsonBody(request)) ?? {};
    const hh = await currentHousehold(ctx);
    const now = () => new Date(ctx.now);
    return idempotentCreate(ctx, hh, body, async (db) => {
      const rule = await acceptRecurringSuggestion({ db, now }, ctx.actor, hh, signature, body);
      return { status: 201, body: { data: recurringRuleToJson(rule) } };
    });
  });
}

export function dismissSuggestionHandler(
  request: Request,
  d: ApiDeps,
  signature: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    const now = () => new Date(ctx.now);
    await dismissRecurringSuggestion({ db: d.db, now }, ctx.actor, hh, signature);
    return json(null, 204);
  });
}
