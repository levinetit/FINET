import "server-only";

import type { DbOrTx } from "@/db";
import { accountToJson, currencyTotalToJson } from "@/modules/accounts/accounts.schema";
import {
  archiveAccount,
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  unarchiveAccount,
  updateAccount,
} from "@/modules/accounts/accounts.service";
import { categoryToJson } from "@/modules/categories/categories.schema";
import {
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  updateCategory,
} from "@/modules/categories/categories.service";
import { getMyHousehold, listMyHouseholds } from "@/modules/households/households.service";
import { transactionTagRefs } from "@/modules/tags/tags.service";
import {
  type TransactionView,
  transactionToJson,
} from "@/modules/transactions/transactions.schema";
import {
  createTransaction,
  deleteTransaction,
  getTransaction,
  listTransactions,
  updateTransaction,
} from "@/modules/transactions/transactions.service";
import { transferToJson } from "@/modules/transfers/transfers.schema";
import {
  createTransfer,
  deleteTransfer,
  getTransfer,
  updateTransfer,
} from "@/modules/transfers/transfers.service";

import {
  type ApiContext,
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
import { accountsAudience, notifyLive, widest } from "./live";

/**
 * Handlerele registrului (`/api/v1/households`, `accounts`, `categories`, `transactions`,
 * `transfers`): subțiri peste serviciile din `src/modules`. Gospodăria vine din sesiune/bază
 * (`currentHousehold`), niciodată din cerere; serviciile validează corpul (Zod strict) și
 * izolează gospodăriile (`withMember` + RLS). Sumele ies ca întregi (`amountMinor`) prin
 * `*ToJson`. Detalii: ADR 0005, `docs/API.md`.
 */

const deps = (db: DbOrTx) => ({ db });
const noBody = () => json(null, 204);

// --- Gospodăriile ----------------------------------------------------------------------------

export function listHouseholdsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    readQuery(request, {});
    return json({ data: await listMyHouseholds(d.db, ctx.actor) });
  });
}

export function getHouseholdHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) =>
    json({ data: await getMyHousehold(d.db, ctx.actor, routeId(id)) }),
  );
}

// --- Conturile -------------------------------------------------------------------------------

export function listAccountsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { includeArchived: "bool" });
    const hh = await currentHousehold(ctx);
    const list = await listAccounts(deps(d.db), ctx.actor, hh, query);
    return json({
      data: list.accounts.map(accountToJson),
      totals: list.totals.map(currencyTotalToJson),
    });
  });
}

export function createAccountHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    return idempotentCreate(ctx, hh, body, async (db) => ({
      status: 201,
      body: { data: accountToJson(await createAccount(deps(db), ctx.actor, hh, body)) },
    }));
  });
}

export function getAccountHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const hh = await currentHousehold(ctx);
    return json({ data: accountToJson(await getAccount(deps(d.db), ctx.actor, hh, routeId(id))) });
  });
}

export function patchAccountHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const accountId = routeId(id);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    const view = await updateAccount(deps(d.db), ctx.actor, hh, accountId, body);
    return json({ data: accountToJson(view) });
  });
}

export function deleteAccountHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const accountId = routeId(id);
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    await deleteAccount(deps(d.db), ctx.actor, hh, accountId);
    return noBody();
  });
}

export function archiveAccountHandler(
  request: Request,
  d: ApiDeps,
  id: string,
  archived: boolean,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const accountId = routeId(id);
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    const fn = archived ? archiveAccount : unarchiveAccount;
    return json({ data: accountToJson(await fn(deps(d.db), ctx.actor, hh, accountId)) });
  });
}

// --- Categoriile -----------------------------------------------------------------------------

export function listCategoriesHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { kind: "string", includeHidden: "bool" });
    const hh = await currentHousehold(ctx);
    const list = await listCategories(deps(d.db), ctx.actor, hh, query);
    return json({ data: list.map(categoryToJson) });
  });
}

export function createCategoryHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    return idempotentCreate(ctx, hh, body, async (db) => ({
      status: 201,
      body: { data: categoryToJson(await createCategory(deps(db), ctx.actor, hh, body)) },
    }));
  });
}

export function getCategoryHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const hh = await currentHousehold(ctx);
    return json({
      data: categoryToJson(await getCategory(deps(d.db), ctx.actor, hh, routeId(id))),
    });
  });
}

export function patchCategoryHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const categoryId = routeId(id);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    const view = await updateCategory(deps(d.db), ctx.actor, hh, categoryId, body);
    return json({ data: categoryToJson(view) });
  });
}

/** `DELETE /categories/{id}?reassignToId=<uuid>` (ținta preia tranzacțiile, 5.6). */
export function deleteCategoryHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const categoryId = routeId(id);
    const query = readQuery(request, { reassignToId: "string" });
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    const options = query.reassignToId === undefined ? {} : { reassignTo: query.reassignToId };
    const result = await deleteCategory(deps(d.db), ctx.actor, hh, categoryId, options);
    return json({ data: result });
  });
}

export function setCategoryHiddenHandler(
  request: Request,
  d: ApiDeps,
  id: string,
  hidden: boolean,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const categoryId = routeId(id);
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    const view = await updateCategory(deps(d.db), ctx.actor, hh, categoryId, { hidden });
    return json({ data: categoryToJson(view) });
  });
}

// --- Tranzacțiile ----------------------------------------------------------------------------

/** Filtrele listei (și ale exportului CSV, F3-B). */
export const TRANSACTION_FILTER_QUERY = {
  q: "string",
  accountId: "string",
  categoryId: "string",
  // Faza 3: id-uri de etichete separate prin virgulă (oricare dintre ele) și comerciantul.
  tagIds: "string",
  // Faza 4: `any` (implicit) sau `all`; doar împreună cu `tagIds`.
  tagMatch: "string",
  merchant: "string",
  type: "string",
  source: "string",
  dateFrom: "string",
  dateTo: "string",
  amountMinMinor: "int",
  amountMaxMinor: "int",
} as const;

export const TRANSACTION_QUERY = {
  ...TRANSACTION_FILTER_QUERY,
  sort: "string",
  cursor: "string",
  limit: "int",
} as const;

/**
 * Parametrii din URL → interogarea serviciului. `tagIds` vine ca un singur parametru cu id-uri
 * separate prin virgulă (un parametru repetat e respins de `readQuery`); validarea (uuid, cel mult
 * 10, distincte, cel puțin unul) o face schema serviciului.
 */
export function transactionQueryOf(
  query: Record<string, string | number | boolean>,
): Record<string, unknown> {
  const { tagIds, ...rest } = query;
  if (tagIds === undefined) return rest;
  const list = String(tagIds) === "" ? [] : String(tagIds).split(",");
  return { ...rest, tagIds: list };
}

/** Tranzacțiile cu etichetele lor (`tags: [{ id, name, color }]`), dintr-o singură interogare. */
async function transactionsJson(
  db: DbOrTx,
  ctx: ApiContext,
  householdId: string,
  views: readonly TransactionView[],
) {
  const refs = await transactionTagRefs(
    deps(db),
    ctx.actor,
    householdId,
    views.filter((v) => v.type !== "transfer").map((v) => v.id),
  );
  return views.map((v) => ({ ...transactionToJson(v), tags: refs.get(v.id) ?? [] }));
}

async function transactionJson(
  db: DbOrTx,
  ctx: ApiContext,
  householdId: string,
  view: TransactionView,
) {
  return (await transactionsJson(db, ctx, householdId, [view]))[0]!;
}

export function listTransactionsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = transactionQueryOf(readQuery(request, TRANSACTION_QUERY));
    const hh = await currentHousehold(ctx);
    const page = await listTransactions(deps(d.db), ctx.actor, hh, query);
    return json({
      data: await transactionsJson(d.db, ctx, hh, page.data),
      nextCursor: page.nextCursor,
    });
  });
}

export function createTransactionHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    // Etichetele se citesc cu `db` primit (tranzacția cheii), ca să vadă legăturile tocmai scrise.
    let created: TransactionView | null = null;
    const response = await idempotentCreate(ctx, hh, body, async (db) => {
      const view = await createTransaction(deps(db), ctx.actor, hh, body);
      created = view;
      return { status: 201, body: { data: await transactionJson(db, ctx, hh, view) } };
    });
    // Faza 8 (ADR 0017): evenimentul live DUPĂ commit; cont personal → doar proprietarul.
    const done = created as TransactionView | null;
    if (done && response.ok) {
      const audience = await accountsAudience(d.db, ctx.actor, hh, [done.accountId]);
      notifyLive(hh, "transaction", done.id, audience);
    }
    return response;
  });
}

export function getTransactionHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const hh = await currentHousehold(ctx);
    const view = await getTransaction(deps(d.db), ctx.actor, hh, routeId(id));
    return json({ data: await transactionJson(d.db, ctx, hh, view) });
  });
}

export function patchTransactionHandler(
  request: Request,
  d: ApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const transactionId = routeId(id);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    // Contul de dinainte: o mutare comun ↔ personal trebuie anunțată și celor care o pierd.
    const before = await getTransaction(deps(d.db), ctx.actor, hh, transactionId);
    const view = await updateTransaction(deps(d.db), ctx.actor, hh, transactionId, body);
    const audience = await accountsAudience(d.db, ctx.actor, hh, [before.accountId]);
    notifyLive(
      hh,
      "transaction",
      view.id,
      widest(audience, await accountsAudience(d.db, ctx.actor, hh, [view.accountId])),
    );
    return json({ data: await transactionJson(d.db, ctx, hh, view) });
  });
}

export function deleteTransactionHandler(
  request: Request,
  d: ApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const transactionId = routeId(id);
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    // Publicul se calculează ÎNAINTE de ștergere (după ea, rândul nu mai există).
    const before = await getTransaction(deps(d.db), ctx.actor, hh, transactionId);
    const audience = await accountsAudience(d.db, ctx.actor, hh, [before.accountId]);
    await deleteTransaction(deps(d.db), ctx.actor, hh, transactionId);
    notifyLive(hh, "transaction", transactionId, audience);
    return noBody();
  });
}

// --- Transferurile ---------------------------------------------------------------------------

export function createTransferHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    let created: { id: string; accounts: string[] } | null = null;
    const response = await idempotentCreate(ctx, hh, body, async (db) => {
      const view = await createTransfer(deps(db), ctx.actor, hh, body);
      created = { id: view.id, accounts: [view.from.accountId, view.to.accountId] };
      return { status: 201, body: { data: transferToJson(view) } };
    });
    const done = created as { id: string; accounts: string[] } | null;
    if (done && response.ok) {
      notifyLive(
        hh,
        "transfer",
        done.id,
        await accountsAudience(d.db, ctx.actor, hh, done.accounts),
      );
    }
    return response;
  });
}

export function getTransferHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const hh = await currentHousehold(ctx);
    return json({
      data: transferToJson(await getTransfer(deps(d.db), ctx.actor, hh, routeId(id))),
    });
  });
}

export function patchTransferHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const transferId = routeId(id);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    const view = await updateTransfer(deps(d.db), ctx.actor, hh, transferId, body);
    const audience = await accountsAudience(d.db, ctx.actor, hh, [
      view.from.accountId,
      view.to.accountId,
    ]);
    notifyLive(hh, "transfer", view.id, audience);
    return json({ data: transferToJson(view) });
  });
}

export function deleteTransferHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const transferId = routeId(id);
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    const before = await getTransfer(deps(d.db), ctx.actor, hh, transferId);
    const audience = await accountsAudience(d.db, ctx.actor, hh, [
      before.from.accountId,
      before.to.accountId,
    ]);
    await deleteTransfer(deps(d.db), ctx.actor, hh, transferId);
    notifyLive(hh, "transfer", transferId, audience);
    return noBody();
  });
}
