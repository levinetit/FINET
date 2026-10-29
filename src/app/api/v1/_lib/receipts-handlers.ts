import "server-only";

import { z } from "zod";

import { getStorage } from "@/lib/storage";
import { receiptDetailToJson, receiptToJson } from "@/modules/receipts/receipts.schema";
import {
  confirmReceipt,
  deleteReceipt,
  getReceipt,
  listReceipts,
  reprocessReceipt,
  updateReceipt,
} from "@/modules/receipts/receipts.service";
import { getTransaction } from "@/modules/transactions/transactions.service";

import type { DocumentsApiDeps } from "./documents-handlers";
import {
  currentHousehold,
  enforceRateLimit,
  handle,
  idempotentCreate,
  json,
  parseWith,
  readJsonBody,
  readOptionalJsonBody,
  readQuery,
  routeId,
} from "./http";
import { accountsAudience, householdAudience, notifyLive } from "./live";

/**
 * Handlerele bonurilor (Faza 6, F6-C; ADR 0015): `GET /receipts`, `GET/PATCH/DELETE
 * /receipts/{id}`, `POST /receipts/{id}/confirm` (→ tranzacție, `Idempotency-Key`) și
 * `POST /receipts/{id}/reprocess`. Aceleași reguli ca restul API-ului (ADR 0005): sesiune, CSRF pe
 * mutațiile cu cookie, gospodăria din sesiune/bază, Zod strict în servicii, 404 uniform, rate
 * limiting; reprocesarea are și o limită proprie (un nou apel AI). Auditul nu conține sume, nume
 * de produse sau comercianți.
 */

const deps = (d: DocumentsApiDeps, now: number) => ({
  db: d.db,
  config: d.config,
  storage: d.storage ?? getStorage(),
  now: () => new Date(now),
});

export function listReceiptsHandler(request: Request, d: DocumentsApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const raw = readQuery(request, {
      status: "string",
      q: "string",
      merchant: "string",
      dateFrom: "string",
      dateTo: "string",
      amountMinMinor: "int",
      amountMaxMinor: "int",
      categoryId: "string",
      tagId: "string",
      cursor: "string",
      limit: "int",
    });
    const hh = await currentHousehold(ctx);
    const page = await listReceipts(deps(d, ctx.now), ctx.actor, hh, raw);
    return json({ data: page.data.map(receiptToJson), nextCursor: page.nextCursor });
  });
}

export function getReceiptHandler(
  request: Request,
  d: DocumentsApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const receiptId = routeId(id);
    readQuery(request, {});
    const hh = await currentHousehold(ctx);
    const r = await getReceipt(deps(d, ctx.now), ctx.actor, hh, receiptId);
    return json({ data: receiptDetailToJson(r) });
  });
}

export function patchReceiptHandler(
  request: Request,
  d: DocumentsApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const receiptId = routeId(id);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    const r = await updateReceipt(deps(d, ctx.now), ctx.actor, hh, receiptId, body);
    return json({ data: receiptDetailToJson(r) });
  });
}

/** Confirmarea: o tranzacție de cheltuială per bon; `Idempotency-Key` recomandat (replay). */
export function confirmReceiptHandler(
  request: Request,
  d: DocumentsApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const receiptId = routeId(id);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    let confirmed: { receiptId: string; transactionId: string } | null = null;
    const response = await idempotentCreate(ctx, hh, body, async (db) => {
      const result = await confirmReceipt(
        { ...deps(d, ctx.now), db },
        ctx.actor,
        hh,
        receiptId,
        body,
      );
      confirmed = { receiptId, transactionId: result.transactionId };
      return {
        status: 201,
        body: {
          data: {
            receipt: receiptDetailToJson(result.receipt),
            transactionId: result.transactionId,
          },
        },
      };
    });
    // Faza 8 (ADR 0017): bonurile sunt ale tuturor membrilor (ADR 0016); tranzacția după cont.
    const done = confirmed as { receiptId: string; transactionId: string } | null;
    if (done && response.ok) {
      notifyLive(hh, "receipt", done.receiptId, householdAudience());
      const tx = await getTransaction({ db: d.db }, ctx.actor, hh, done.transactionId).catch(
        () => null,
      );
      if (tx) {
        notifyLive(
          hh,
          "transaction",
          tx.id,
          await accountsAudience(d.db, ctx.actor, hh, [tx.accountId]),
        );
      }
    }
    return response;
  });
}

/** Corpul reprocesării: gol, `{}` sau `{ order: [2, 1, 3] }` („Ordonează automat”, bon lung). */
const reprocessBody = z.strictObject({
  order: z.array(z.number().int().min(1).max(4)).min(2).max(4).optional(),
});

export function reprocessReceiptHandler(
  request: Request,
  d: DocumentsApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const receiptId = routeId(id);
    const body = parseWith(reprocessBody, (await readOptionalJsonBody(request)) ?? {});
    await enforceRateLimit(ctx, "api_receipt_reprocess", ctx.limits.receiptReprocess);
    const hh = await currentHousehold(ctx);
    const r = await reprocessReceipt(deps(d, ctx.now), ctx.actor, hh, receiptId, body.order);
    return json({ data: { documentIds: [...r.documentIds], queued: r.queued } }, 202);
  });
}

/** Șterge bonul și documentele lui (fișierele); tranzacția creată din bon rămâne. */
export function deleteReceiptHandler(
  request: Request,
  d: DocumentsApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const receiptId = routeId(id);
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    await deleteReceipt(deps(d, ctx.now), ctx.actor, hh, receiptId);
    return json(null, 204);
  });
}
