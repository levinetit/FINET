import "server-only";

import { type SQL, and, asc, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import { transactionTags, transactions } from "@/db/schema";

import type { Cursor, TransactionSort } from "./transactions.schema";

/** Accesul la `transactions` (în tranzacția `withMember`, cu RLS și filtru pe gospodărie). */

export type TransactionRow = typeof transactions.$inferSelect;

export async function selectTransaction(
  tx: Tx,
  householdId: string,
  id: string,
  lock = false,
): Promise<TransactionRow | null> {
  const q = tx
    .select()
    .from(transactions)
    .where(and(eq(transactions.householdId, householdId), eq(transactions.id, id)))
    .limit(1);
  const rows = lock ? await q.for("update") : await q;
  return rows[0] ?? null;
}

/** Rândurile unui grup de transfer (`out` întâi), blocate opțional. */
export async function selectTransferGroup(
  tx: Tx,
  householdId: string,
  groupId: string,
  lock = false,
): Promise<TransactionRow[]> {
  const q = tx
    .select()
    .from(transactions)
    .where(
      and(eq(transactions.householdId, householdId), eq(transactions.transferGroupId, groupId)),
    )
    .orderBy(desc(transactions.transferDirection));
  return lock ? q.for("update") : q;
}

export async function insertTransactionRow(
  tx: Tx,
  values: typeof transactions.$inferInsert,
): Promise<TransactionRow> {
  const [row] = await tx.insert(transactions).values(values).returning();
  return row!;
}

export async function updateTransactionRow(
  tx: Tx,
  householdId: string,
  id: string,
  patch: Partial<
    Pick<
      typeof transactions.$inferInsert,
      | "accountId"
      | "categoryId"
      | "type"
      | "amountMinor"
      | "currency"
      | "occurredOn"
      | "description"
      | "merchant"
      | "notes"
    >
  >,
): Promise<TransactionRow | null> {
  const [row] = await tx
    .update(transactions)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(transactions.householdId, householdId), eq(transactions.id, id)))
    .returning();
  return row ?? null;
}

export async function deleteTransactionRows(
  tx: Tx,
  householdId: string,
  where: Readonly<{ id: string } | { transferGroupId: string }>,
): Promise<number> {
  const cond =
    "id" in where
      ? eq(transactions.id, where.id)
      : eq(transactions.transferGroupId, where.transferGroupId);
  const rows = await tx
    .delete(transactions)
    .where(and(eq(transactions.householdId, householdId), cond))
    .returning({ id: transactions.id });
  return rows.length;
}

/** Escapare pentru `ILIKE`: `\`, `%` și `_` din textul căutat sunt caractere obișnuite. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export type ListFilters = Readonly<{
  q?: string;
  accountId?: string;
  categoryId?: string;
  tagIds?: readonly string[];
  /** `any` (implicit): cel puțin una dintre `tagIds`; `all`: toate. */
  tagMatch?: "any" | "all";
  merchant?: string;
  type?: TransactionRow["type"];
  source?: TransactionRow["source"];
  dateFrom?: string;
  dateTo?: string;
  amountMinMinor?: bigint;
  amountMaxMinor?: bigint;
}>;

/**
 * O pagină de tranzacții, cu paginare pe cheie (keyset) pe `(cheie de sortare, id)`: stabilă la
 * inserări concurente (rândurile existente nu se dublează și nu se pierd între pagini). Se citesc
 * `limit + 1` rânduri, ca apelantul să știe dacă există o pagină următoare.
 */
/** Condițiile filtrelor listei (aceleași pentru pagină, numărare și export). */
function filterConditions(householdId: string, filters: ListFilters): SQL[] {
  const t = transactions;
  const conditions: SQL[] = [eq(t.householdId, householdId)];
  if (filters.accountId) conditions.push(eq(t.accountId, filters.accountId));
  if (filters.categoryId) conditions.push(eq(t.categoryId, filters.categoryId));
  if (filters.type) conditions.push(eq(t.type, filters.type));
  if (filters.tagIds && filters.tagIds.length > 0) {
    const ids = sql.join(
      filters.tagIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    if (filters.tagMatch === "all") {
      // Toate etichetele: numărul legăturilor cu etichetele căutate = numărul lor. Corect pentru
      // că `tagIds` sunt distincte (schema) și `(transaction_id, tag_id)` e cheie primară.
      conditions.push(sql`(select count(*) from ${transactionTags} tt
        where tt.transaction_id = ${t.id} and tt.household_id = ${householdId}
          and tt.tag_id in (${ids})) = ${filters.tagIds.length}`);
    } else {
      // EXISTS, nu JOIN: o tranzacție cu două etichete căutate apare o singură dată, deci
      // paginarea pe cheie rămâne stabilă.
      conditions.push(sql`exists (select 1 from ${transactionTags} tt
        where tt.transaction_id = ${t.id} and tt.household_id = ${householdId}
          and tt.tag_id in (${ids}))`);
    }
  }
  if (filters.merchant) conditions.push(ilike(t.merchant, `%${escapeLike(filters.merchant)}%`));
  if (filters.source) conditions.push(eq(t.source, filters.source));
  if (filters.dateFrom) conditions.push(gte(t.occurredOn, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(t.occurredOn, filters.dateTo));
  if (filters.amountMinMinor !== undefined)
    conditions.push(gte(t.amountMinor, filters.amountMinMinor));
  if (filters.amountMaxMinor !== undefined)
    conditions.push(lte(t.amountMinor, filters.amountMaxMinor));
  if (filters.q) {
    const pattern = `%${escapeLike(filters.q)}%`;
    conditions.push(
      or(ilike(t.description, pattern), ilike(t.merchant, pattern), ilike(t.notes, pattern))!,
    );
  }
  return conditions;
}

/** Numărul de tranzacții care corespund filtrelor (plafonul exportului CSV). */
export async function countTransactions(
  tx: Tx,
  householdId: string,
  filters: ListFilters,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(transactions)
    .where(and(...filterConditions(householdId, filters)));
  return Number(row?.n ?? 0);
}

export async function selectTransactionPage(
  tx: Tx,
  householdId: string,
  filters: ListFilters,
  sort: TransactionSort,
  cursor: Cursor | null,
  limit: number,
): Promise<TransactionRow[]> {
  const t = transactions;
  const conditions = filterConditions(householdId, filters);

  const byDate = sort.startsWith("date_");
  const descending = sort.endsWith("_desc");
  const keyColumn = byDate ? t.occurredOn : t.amountMinor;
  if (cursor) {
    const key = byDate ? sql`${cursor.key}::date` : sql`${cursor.key}::bigint`;
    conditions.push(
      descending
        ? sql`(${keyColumn}, ${t.id}) < (${key}, ${cursor.id}::uuid)`
        : sql`(${keyColumn}, ${t.id}) > (${key}, ${cursor.id}::uuid)`,
    );
  }
  const dir = descending ? desc : asc;
  return tx
    .select()
    .from(t)
    .where(and(...conditions))
    .orderBy(dir(keyColumn), dir(t.id))
    .limit(limit + 1);
}
