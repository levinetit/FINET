import "server-only";

import { and, asc, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import {
  receiptLines,
  receipts,
  shoppingListAiRequests,
  shoppingListItems,
  shoppingLists,
} from "@/db/schema";

/**
 * Accesul la listele de cumpărături (în tranzacția `withMember`, cu RLS ȘI filtru pe gospodărie).
 * O listă personală a altui membru nu apare niciodată aici: RLS o ascunde, deci un id străin e
 * "negăsit", la fel ca unul inexistent.
 */

export type ListRow = typeof shoppingLists.$inferSelect;
export type ListRowWithCounts = ListRow & { itemCount: number; checkedCount: number };
export type ItemRow = typeof shoppingListItems.$inferSelect;
export type AiRequestRow = typeof shoppingListAiRequests.$inferSelect;

// Coloana listei se scrie calificat (`finet.shopping_lists.id`): drizzle omite calificarea într-un
// SELECT pe o singură tabelă, iar `id` nealificat s-ar lega de `i.id` din subinterogare.
const counts = {
  itemCount: sql<number>`(select count(*)::int from finet.shopping_list_items i
    where i.list_id = finet.shopping_lists.id)`,
  checkedCount: sql<number>`(select count(*)::int from finet.shopping_list_items i
    where i.list_id = finet.shopping_lists.id and i.checked)`,
};

export async function selectLists(
  tx: Tx,
  householdId: string,
  status?: ListRow["status"],
): Promise<ListRowWithCounts[]> {
  const conditions = [eq(shoppingLists.householdId, householdId)];
  if (status) conditions.push(eq(shoppingLists.status, status));
  return tx
    .select({ ...getTableColumns(shoppingLists), ...counts })
    .from(shoppingLists)
    .where(and(...conditions))
    .orderBy(desc(shoppingLists.updatedAt), asc(shoppingLists.id));
}

export async function selectList(
  tx: Tx,
  householdId: string,
  id: string,
  lock = false,
): Promise<ListRowWithCounts | null> {
  const q = tx
    .select({ ...getTableColumns(shoppingLists), ...counts })
    .from(shoppingLists)
    .where(and(eq(shoppingLists.householdId, householdId), eq(shoppingLists.id, id)))
    .limit(1);
  // `FOR UPDATE` nu se combină cu subinterogările scalare din SELECT în toate versiunile; blocăm
  // rândul listei într-o interogare separată, apoi citim numărătorile.
  if (lock) {
    await tx
      .select({ id: shoppingLists.id })
      .from(shoppingLists)
      .where(and(eq(shoppingLists.householdId, householdId), eq(shoppingLists.id, id)))
      .limit(1)
      .for("update");
  }
  const rows = await q;
  return rows[0] ?? null;
}

export async function insertList(
  tx: Tx,
  values: typeof shoppingLists.$inferInsert,
): Promise<ListRow> {
  const [row] = await tx.insert(shoppingLists).values(values).returning();
  return row!;
}

export async function updateListRow(
  tx: Tx,
  householdId: string,
  id: string,
  patch: Partial<Pick<typeof shoppingLists.$inferInsert, "name" | "status" | "ownerUserId">>,
): Promise<ListRow | null> {
  const [row] = await tx
    .update(shoppingLists)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(shoppingLists.householdId, householdId), eq(shoppingLists.id, id)))
    .returning();
  return row ?? null;
}

export async function touchList(tx: Tx, householdId: string, id: string): Promise<void> {
  await tx
    .update(shoppingLists)
    .set({ updatedAt: new Date() })
    .where(and(eq(shoppingLists.householdId, householdId), eq(shoppingLists.id, id)));
}

export async function deleteListRow(tx: Tx, householdId: string, id: string): Promise<boolean> {
  const rows = await tx
    .delete(shoppingLists)
    .where(and(eq(shoppingLists.householdId, householdId), eq(shoppingLists.id, id)))
    .returning({ id: shoppingLists.id });
  return rows.length > 0;
}

export async function selectItems(tx: Tx, householdId: string, listId: string): Promise<ItemRow[]> {
  return tx
    .select()
    .from(shoppingListItems)
    .where(and(eq(shoppingListItems.householdId, householdId), eq(shoppingListItems.listId, listId)))
    .orderBy(
      asc(shoppingListItems.position),
      asc(shoppingListItems.createdAt),
      asc(shoppingListItems.id),
    );
}

export async function selectItem(
  tx: Tx,
  householdId: string,
  listId: string,
  id: string,
  lock = false,
): Promise<ItemRow | null> {
  const q = tx
    .select()
    .from(shoppingListItems)
    .where(
      and(
        eq(shoppingListItems.householdId, householdId),
        eq(shoppingListItems.listId, listId),
        eq(shoppingListItems.id, id),
      ),
    )
    .limit(1);
  const rows = lock ? await q.for("update") : await q;
  return rows[0] ?? null;
}

export async function insertItems(
  tx: Tx,
  values: (typeof shoppingListItems.$inferInsert)[],
): Promise<ItemRow[]> {
  if (values.length === 0) return [];
  return tx.insert(shoppingListItems).values(values).returning();
}

export async function updateItemRow(
  tx: Tx,
  householdId: string,
  listId: string,
  id: string,
  patch: Partial<
    Pick<
      typeof shoppingListItems.$inferInsert,
      | "name"
      | "normalizedName"
      | "quantity"
      | "unit"
      | "note"
      | "checked"
      | "checkedByUserId"
      | "checkedAt"
      | "position"
      | "matchedReceiptLineId"
      | "matchStatus"
      | "matchScore"
      | "matchSource"
    >
  >,
): Promise<ItemRow | null> {
  const [row] = await tx
    .update(shoppingListItems)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(shoppingListItems.householdId, householdId),
        eq(shoppingListItems.listId, listId),
        eq(shoppingListItems.id, id),
      ),
    )
    .returning();
  return row ?? null;
}

export async function deleteItemRow(
  tx: Tx,
  householdId: string,
  listId: string,
  id: string,
): Promise<boolean> {
  const rows = await tx
    .delete(shoppingListItems)
    .where(
      and(
        eq(shoppingListItems.householdId, householdId),
        eq(shoppingListItems.listId, listId),
        eq(shoppingListItems.id, id),
      ),
    )
    .returning({ id: shoppingListItems.id });
  return rows.length > 0;
}

export async function maxItemPosition(tx: Tx, householdId: string, listId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number>`coalesce(max(${shoppingListItems.position}), 0)::int` })
    .from(shoppingListItems)
    .where(and(eq(shoppingListItems.householdId, householdId), eq(shoppingListItems.listId, listId)));
  return row?.max ?? 0;
}

/** Pozițiile 1..n în ordinea dată (un singur UPDATE, `CASE`), doar pentru articolele listei. */
export async function setItemPositions(
  tx: Tx,
  householdId: string,
  listId: string,
  orderedIds: readonly string[],
): Promise<void> {
  if (orderedIds.length === 0) return;
  const whens = orderedIds.map((id, i) => sql`when ${id}::uuid then ${i + 1}::int`);
  await tx
    .update(shoppingListItems)
    .set({
      position: sql`case ${shoppingListItems.id} ${sql.join(whens, sql` `)} end`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(shoppingListItems.householdId, householdId),
        eq(shoppingListItems.listId, listId),
        inArray(shoppingListItems.id, [...orderedIds]),
      ),
    );
}

// --- Bonul și liniile lui (doar citire) ---------------------------------------------------------

export type ReceiptLineRow = Readonly<{
  id: string;
  receiptId: string;
  position: number;
  rawName: string;
  normalizedName: string | null;
  quantity: string | null;
  kind: (typeof receiptLines.$inferSelect)["kind"];
}>;

export type ReceiptHeader = Readonly<{
  id: string;
  merchantName: string | null;
  occurredOn: string | null;
  status: (typeof receipts.$inferSelect)["status"];
}>;

export async function selectReceiptHeader(
  tx: Tx,
  householdId: string,
  receiptId: string,
): Promise<ReceiptHeader | null> {
  const [row] = await tx
    .select({
      id: receipts.id,
      merchantName: receipts.merchantName,
      occurredOn: receipts.occurredOn,
      status: receipts.status,
    })
    .from(receipts)
    .where(and(eq(receipts.householdId, householdId), eq(receipts.id, receiptId)))
    .limit(1);
  return row ?? null;
}

export async function selectReceiptLines(
  tx: Tx,
  householdId: string,
  receiptId: string,
): Promise<ReceiptLineRow[]> {
  return tx
    .select({
      id: receiptLines.id,
      receiptId: receiptLines.receiptId,
      position: receiptLines.position,
      rawName: receiptLines.rawName,
      normalizedName: receiptLines.normalizedName,
      quantity: receiptLines.quantity,
      kind: receiptLines.kind,
    })
    .from(receiptLines)
    .where(and(eq(receiptLines.householdId, householdId), eq(receiptLines.receiptId, receiptId)))
    .orderBy(asc(receiptLines.position));
}

/** Liniile (cu bonul lor) după id, doar din gospodărie. */
export async function selectLinesByIds(
  tx: Tx,
  householdId: string,
  ids: readonly string[],
): Promise<ReceiptLineRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select({
      id: receiptLines.id,
      receiptId: receiptLines.receiptId,
      position: receiptLines.position,
      rawName: receiptLines.rawName,
      normalizedName: receiptLines.normalizedName,
      quantity: receiptLines.quantity,
      kind: receiptLines.kind,
    })
    .from(receiptLines)
    .where(and(eq(receiptLines.householdId, householdId), inArray(receiptLines.id, [...ids])));
}

/** Bonurile confirmate recent (pentru alegerea bonului din ecranul listei). */
export async function selectRecentSavedReceipts(
  tx: Tx,
  householdId: string,
  limit: number,
): Promise<ReceiptHeader[]> {
  return tx
    .select({
      id: receipts.id,
      merchantName: receipts.merchantName,
      occurredOn: receipts.occurredOn,
      status: receipts.status,
    })
    .from(receipts)
    .where(and(eq(receipts.householdId, householdId), eq(receipts.status, "saved")))
    .orderBy(sql`${receipts.occurredOn} desc nulls last`, desc(receipts.createdAt), asc(receipts.id))
    .limit(limit);
}

/**
 * Istoricul confirmărilor/respingerilor din gospodărie: perechi (nume articol normalizat, nume
 * linie normalizat), pentru cel mult `limit` articole recente. Articolele vin sub RLS-ul
 * apelantului (listele personale ale altora nu contribuie).
 */
export async function selectPairHistory(
  tx: Tx,
  householdId: string,
  limit: number,
): Promise<
  {
    status: ItemRow["matchStatus"];
    itemName: string;
    lineNormalized: string | null;
    lineRaw: string;
  }[]
> {
  return tx
    .select({
      status: shoppingListItems.matchStatus,
      itemName: shoppingListItems.normalizedName,
      lineNormalized: receiptLines.normalizedName,
      lineRaw: receiptLines.rawName,
    })
    .from(shoppingListItems)
    .innerJoin(
      receiptLines,
      and(
        eq(receiptLines.id, shoppingListItems.matchedReceiptLineId),
        eq(receiptLines.householdId, shoppingListItems.householdId),
      ),
    )
    .where(
      and(
        eq(shoppingListItems.householdId, householdId),
        inArray(shoppingListItems.matchStatus, ["confirmed", "rejected"]),
      ),
    )
    .orderBy(desc(shoppingListItems.updatedAt), asc(shoppingListItems.id))
    .limit(limit);
}

/**
 * Produsele cumpărate des (nume normalizat + de câte ori), din liniile `product` ale bonurilor
 * confirmate din ultimele `sinceDays` zile, filtrate opțional după un prefix al cuvintelor.
 * Calculat în cod/SQL, fără LLM; doar nume normalizate.
 */
export async function selectFrequentProducts(
  tx: Tx,
  householdId: string,
  sinceDays: number,
  prefix: string | null,
  limit: number,
): Promise<{ name: string; n: number }[]> {
  const like = prefix === null ? null : `${escapeLike(prefix)}%`;
  const likeWord = prefix === null ? null : `% ${escapeLike(prefix)}%`;
  const rows = (await tx.execute(sql`
    select l.normalized_name as name, count(*)::int as n
      from finet.receipt_lines l
      join finet.receipts r on r.id = l.receipt_id and r.household_id = l.household_id
     where l.household_id = ${householdId}
       and r.status = 'saved'
       and l.kind = 'product'
       and l.normalized_name is not null
       and coalesce(r.occurred_on, r.created_at::date) >= (current_date - ${sinceDays}::int)
       and (${like}::text is null
            or l.normalized_name like ${like}::text escape '\\'
            or l.normalized_name like ${likeWord}::text escape '\\')
     group by l.normalized_name
     order by count(*) desc, l.normalized_name
     limit ${limit}::int`)) as unknown as { name: string; n: number }[];
  return rows;
}

function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// --- Cererile AI --------------------------------------------------------------------------------

export async function selectAiRequest(
  tx: Tx,
  householdId: string,
  listId: string,
  receiptId: string,
): Promise<AiRequestRow | null> {
  const [row] = await tx
    .select()
    .from(shoppingListAiRequests)
    .where(
      and(
        eq(shoppingListAiRequests.householdId, householdId),
        eq(shoppingListAiRequests.listId, listId),
        eq(shoppingListAiRequests.receiptId, receiptId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * (Re)pune în coadă cererea pentru perechea (listă, bon): una nouă `queued`, sau una existentă
 * terminată (`done`/`failed`/`skipped`) readusă la `queued` cu încercările la 0. Una în lucru
 * (`queued`/`processing`) rămâne neschimbată.
 */
export async function upsertAiRequest(
  tx: Tx,
  values: Readonly<{
    householdId: string;
    listId: string;
    receiptId: string;
    requestedByUserId: string;
  }>,
): Promise<AiRequestRow> {
  const [row] = await tx
    .insert(shoppingListAiRequests)
    .values(values)
    .onConflictDoUpdate({
      target: [shoppingListAiRequests.listId, shoppingListAiRequests.receiptId],
      set: {
        status: sql`case when ${shoppingListAiRequests.status} in ('queued', 'processing')
          then ${shoppingListAiRequests.status} else 'queued' end`,
        attempts: sql`case when ${shoppingListAiRequests.status} in ('queued', 'processing')
          then ${shoppingListAiRequests.attempts} else 0 end`,
        errorCode: sql`case when ${shoppingListAiRequests.status} in ('queued', 'processing')
          then ${shoppingListAiRequests.errorCode} else null end`,
        processingStartedAt: sql`case when ${shoppingListAiRequests.status} in ('queued', 'processing')
          then ${shoppingListAiRequests.processingStartedAt} else null end`,
        requestedByUserId: sql`case when ${shoppingListAiRequests.status} in ('queued', 'processing')
          then ${shoppingListAiRequests.requestedByUserId} else ${values.requestedByUserId}::uuid end`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row!;
}
