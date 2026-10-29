import "server-only";

import type { Audience } from "./live";
import {
  getComparison,
  listComparableReceipts,
  runComparison,
  setItemMatch,
} from "@/modules/shopping/compare.service";
import { itemToJson, listToJson, listWithItemsToJson } from "@/modules/shopping/shopping.schema";
import {
  addItem,
  copyList,
  createList,
  deleteItem,
  deleteList,
  getList,
  listLists,
  reorderItems,
  suggestProducts,
  updateItem,
  updateList,
} from "@/modules/shopping/shopping.service";

import {
  type ApiContext,
  type ApiDeps,
  currentHousehold,
  enforceRateLimit,
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
 * Handlerele listelor de cumpărături (Faza 10, F10-A; ADR 0022). Aceleași reguli ca restul
 * `/api/v1` (ADR 0005): sesiune, gospodăria din bază, Zod strict în servicii, 404 uniform
 * (inclusiv pentru lista PERSONALĂ a altui membru), `Idempotency-Key` pe crearea resurselor,
 * rate limiting pe mutații (și separat pe comparație și sugestii).
 *
 * Bifarea (`PATCH …/items/{itemId}` cu `checked`) e o stare explicită: idempotentă fără cheie.
 * Evenimentele live (`shopping_list`, id = lista) se publică DUPĂ ce mutația s-a încheiat; o listă
 * personală ajunge doar la proprietar.
 */

const noBody = () => json(null, 204);

/** Publicul unui eveniment: toată gospodăria pentru o listă comună, altfel doar actorul. */
function audienceOf(ctx: ApiContext, shared: boolean): Audience {
  return shared ? householdAudience() : { onlyUserId: ctx.actor.userId };
}

function announce(ctx: ApiContext, hh: string, listId: string, shared: boolean): void {
  notifyLive(hh, "shopping_list", listId, audienceOf(ctx, shared));
}

// --- Listele -----------------------------------------------------------------------------------

export function listShoppingListsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { status: "string" });
    const hh = await currentHousehold(ctx);
    const lists = await listLists({ db: d.db }, ctx.actor, hh, query);
    return json({ data: lists.map(listToJson) });
  });
}

export function createShoppingListHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    let created: { id: string; shared: boolean } | null = null;
    const response = await idempotentCreate(ctx, hh, body, async (db) => {
      const view = await createList({ db }, ctx.actor, hh, body);
      created = { id: view.list.id, shared: view.list.shared };
      return { status: 201, body: { data: listWithItemsToJson(view) } };
    });
    const c = created as { id: string; shared: boolean } | null;
    if (c && response.ok) announce(ctx, hh, c.id, c.shared);
    return response;
  });
}

export function getShoppingListHandler(
  request: Request,
  d: ApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const hh = await currentHousehold(ctx);
    const view = await getList({ db: d.db }, ctx.actor, hh, routeId(id));
    return json({ data: listWithItemsToJson(view) });
  });
}

export function patchShoppingListHandler(
  request: Request,
  d: ApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const listId = routeId(id);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    const view = await updateList({ db: d.db }, ctx.actor, hh, listId, body);
    announce(ctx, hh, listId, view.shared);
    return json({ data: listToJson(view) });
  });
}

export function deleteShoppingListHandler(
  request: Request,
  d: ApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const listId = routeId(id);
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    const { shared } = await deleteList({ db: d.db }, ctx.actor, hh, listId);
    announce(ctx, hh, listId, shared);
    return noBody();
  });
}

export function copyShoppingListHandler(
  request: Request,
  d: ApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const listId = routeId(id);
    const body = (await readOptionalJsonBody(request)) ?? {};
    const hh = await currentHousehold(ctx);
    let created: { id: string; shared: boolean } | null = null;
    const response = await idempotentCreate(ctx, hh, body, async (db) => {
      const view = await copyList({ db }, ctx.actor, hh, listId, body);
      created = { id: view.list.id, shared: view.list.shared };
      return { status: 201, body: { data: listWithItemsToJson(view) } };
    });
    const c = created as { id: string; shared: boolean } | null;
    if (c && response.ok) announce(ctx, hh, c.id, c.shared);
    return response;
  });
}

export function reorderShoppingItemsHandler(
  request: Request,
  d: ApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const listId = routeId(id);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    const view = await reorderItems({ db: d.db }, ctx.actor, hh, listId, body);
    announce(ctx, hh, listId, view.list.shared);
    return json({ data: listWithItemsToJson(view) });
  });
}

// --- Articolele --------------------------------------------------------------------------------

export function addShoppingItemHandler(
  request: Request,
  d: ApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const listId = routeId(id);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    let shared: boolean | null = null;
    const response = await idempotentCreate(ctx, hh, body, async (db) => {
      const result = await addItem({ db }, ctx.actor, hh, listId, body);
      shared = result.shared;
      return { status: 201, body: { data: itemToJson(result.item) } };
    });
    if (shared !== null && response.ok) announce(ctx, hh, listId, shared as boolean);
    return response;
  });
}

export function patchShoppingItemHandler(
  request: Request,
  d: ApiDeps,
  id: string,
  itemId: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const listId = routeId(id);
    const item = routeId(itemId);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    const result = await updateItem({ db: d.db }, ctx.actor, hh, listId, item, body);
    announce(ctx, hh, listId, result.shared);
    return json({ data: itemToJson(result.item) });
  });
}

export function deleteShoppingItemHandler(
  request: Request,
  d: ApiDeps,
  id: string,
  itemId: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const listId = routeId(id);
    const item = routeId(itemId);
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    const { shared } = await deleteItem({ db: d.db }, ctx.actor, hh, listId, item);
    announce(ctx, hh, listId, shared);
    return noBody();
  });
}

// --- Sugestii și comparația --------------------------------------------------------------------

export function shoppingSuggestionsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { q: "string" });
    await enforceRateLimit(ctx, "api_shopping_suggest", ctx.limits.shoppingSuggest);
    const hh = await currentHousehold(ctx);
    return json({ data: await suggestProducts({ db: d.db }, ctx.actor, hh, query) });
  });
}

export function shoppingReceiptsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    readQuery(request, {});
    const hh = await currentHousehold(ctx);
    return json({ data: await listComparableReceipts({ db: d.db }, ctx.actor, hh) });
  });
}

export function runShoppingComparisonHandler(
  request: Request,
  d: ApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const listId = routeId(id);
    const body = await readJsonBody(request);
    await enforceRateLimit(ctx, "api_shopping_compare", ctx.limits.shoppingCompare);
    const hh = await currentHousehold(ctx);
    const result = await runComparison({ db: d.db }, ctx.actor, hh, listId, body);
    announce(ctx, hh, listId, result.shared);
    return json({ data: result.view });
  });
}

export function getShoppingComparisonHandler(
  request: Request,
  d: ApiDeps,
  id: string,
  receiptId: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const listId = routeId(id);
    const receipt = routeId(receiptId);
    readQuery(request, {});
    const hh = await currentHousehold(ctx);
    const result = await getComparison({ db: d.db }, ctx.actor, hh, listId, receipt);
    return json({ data: result.view });
  });
}

export function matchShoppingItemHandler(
  request: Request,
  d: ApiDeps,
  id: string,
  itemId: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const listId = routeId(id);
    const item = routeId(itemId);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    const result = await setItemMatch({ db: d.db }, ctx.actor, hh, listId, item, body);
    announce(ctx, hh, listId, result.shared);
    return json({ data: itemToJson(result.item) });
  });
}
