import "server-only";

import { type SQL, and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import { tagVisibility, tags, transactionTags } from "@/db/schema";

/**
 * Accesul la etichete (în tranzacția `withMember`, cu RLS). Etichetele vizibile unei gospodării =
 * cele de sistem (`household_id IS NULL`) + cele proprii; filtrul explicit dublează RLS.
 */

export type TagRow = typeof tags.$inferSelect & {
  visibilityHidden: boolean | null;
  usageCount: number;
};

const visibleTo = (householdId: string) =>
  or(isNull(tags.householdId), eq(tags.householdId, householdId));

function usageOf(householdId: string): SQL<number> {
  return sql<number>`(select count(*)::int from ${transactionTags} tt
    where tt.tag_id = ${tags.id} and tt.household_id = ${householdId})`;
}

function selectBase(tx: Tx, householdId: string) {
  return tx
    .select({ t: tags, visibilityHidden: tagVisibility.hidden, usageCount: usageOf(householdId) })
    .from(tags)
    .leftJoin(
      tagVisibility,
      and(eq(tagVisibility.tagId, tags.id), eq(tagVisibility.householdId, householdId)),
    );
}

type BaseRow = {
  t: typeof tags.$inferSelect;
  visibilityHidden: boolean | null;
  usageCount: number;
};
const flatten = (r: BaseRow): TagRow => ({
  ...r.t,
  visibilityHidden: r.visibilityHidden,
  usageCount: Number(r.usageCount),
});

export async function selectTags(tx: Tx, householdId: string): Promise<TagRow[]> {
  const rows = await selectBase(tx, householdId)
    .where(visibleTo(householdId))
    .orderBy(
      sql`${tags.householdId} is not null`,
      asc(tags.sortOrder),
      asc(sql`lower(${tags.name})`),
      asc(tags.id),
    );
  return rows.map(flatten);
}

export async function selectTag(
  tx: Tx,
  householdId: string,
  id: string,
  lock = false,
): Promise<TagRow | null> {
  if (lock) {
    // Doar etichetele proprii se blochează (pe cele de sistem finet_app nu le poate modifica).
    const locked = await tx
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.id, id), eq(tags.householdId, householdId)))
      .for("update");
    if (locked.length === 0) return null;
  }
  const rows = await selectBase(tx, householdId)
    .where(and(eq(tags.id, id), visibleTo(householdId)))
    .limit(1);
  return rows[0] ? flatten(rows[0]) : null;
}

/** Există deja o etichetă vizibilă (de sistem sau proprie) cu același nume (fără majuscule)? */
export async function tagNameTaken(
  tx: Tx,
  householdId: string,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const conditions = [visibleTo(householdId), sql`lower(${tags.name}) = lower(${name})`];
  if (exceptId) conditions.push(sql`${tags.id} <> ${exceptId}`);
  const rows = await tx
    .select({ one: sql<number>`1` })
    .from(tags)
    .where(and(...conditions))
    .limit(1);
  return rows.length > 0;
}

export async function insertTag(
  tx: Tx,
  values: typeof tags.$inferInsert,
): Promise<typeof tags.$inferSelect> {
  const [row] = await tx.insert(tags).values(values).returning();
  return row!;
}

export async function updateTagRow(
  tx: Tx,
  householdId: string,
  id: string,
  patch: Partial<Pick<typeof tags.$inferInsert, "name" | "color" | "hidden">>,
): Promise<boolean> {
  const rows = await tx
    .update(tags)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(tags.householdId, householdId), eq(tags.id, id)))
    .returning({ id: tags.id });
  return rows.length > 0;
}

export async function upsertTagVisibility(
  tx: Tx,
  householdId: string,
  tagId: string,
  hidden: boolean,
): Promise<void> {
  await tx
    .insert(tagVisibility)
    .values({ householdId, tagId, hidden })
    .onConflictDoUpdate({
      target: [tagVisibility.householdId, tagVisibility.tagId],
      set: { hidden, updatedAt: new Date() },
    });
}

/** Șterge o etichetă proprie; legăturile cu tranzacțiile dispar în cascadă. */
export async function deleteTagRow(tx: Tx, householdId: string, id: string): Promise<boolean> {
  const rows = await tx
    .delete(tags)
    .where(and(eq(tags.householdId, householdId), eq(tags.id, id)))
    .returning({ id: tags.id });
  return rows.length > 0;
}

/** Id-urile din `ids` care sunt etichete vizibile gospodăriei. */
export async function selectVisibleTagIds(
  tx: Tx,
  householdId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(visibleTo(householdId), inArray(tags.id, [...ids])));
  return new Set(rows.map((r) => r.id));
}

/** Înlocuiește etichetele unei tranzacții cu `tagIds` (deja validate). */
export async function replaceTransactionTags(
  tx: Tx,
  householdId: string,
  transactionId: string,
  tagIds: readonly string[],
): Promise<void> {
  await tx
    .delete(transactionTags)
    .where(
      and(
        eq(transactionTags.householdId, householdId),
        eq(transactionTags.transactionId, transactionId),
      ),
    );
  if (tagIds.length === 0) return;
  await tx
    .insert(transactionTags)
    .values(tagIds.map((tagId) => ({ transactionId, tagId, householdId })));
}

/** Etichetele (id-uri, ordonate) ale tranzacțiilor date. */
export async function selectTagIdsOf(
  tx: Tx,
  householdId: string,
  transactionIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (transactionIds.length === 0) return out;
  const rows = await tx
    .select({ transactionId: transactionTags.transactionId, tagId: transactionTags.tagId })
    .from(transactionTags)
    .where(
      and(
        eq(transactionTags.householdId, householdId),
        inArray(transactionTags.transactionId, [...transactionIds]),
      ),
    )
    .orderBy(asc(transactionTags.transactionId), asc(transactionTags.tagId));
  for (const r of rows) {
    const list = out.get(r.transactionId) ?? [];
    list.push(r.tagId);
    out.set(r.transactionId, list);
  }
  return out;
}

export type TagRef = Readonly<{ id: string; name: string; color: string | null }>;

/**
 * Etichetele (id, nume, culoare) ale tranzacțiilor date, într-o singură interogare (fără N+1),
 * ordonate după nume (fără majuscule) și id. Include și etichetele ascunse și cele de sistem.
 */
export async function selectTagRefsOf(
  tx: Tx,
  householdId: string,
  transactionIds: readonly string[],
): Promise<Map<string, TagRef[]>> {
  const out = new Map<string, TagRef[]>();
  if (transactionIds.length === 0) return out;
  const rows = await tx
    .select({
      transactionId: transactionTags.transactionId,
      id: tags.id,
      name: tags.name,
      color: tags.color,
    })
    .from(transactionTags)
    .innerJoin(tags, eq(tags.id, transactionTags.tagId))
    .where(
      and(
        eq(transactionTags.householdId, householdId),
        inArray(transactionTags.transactionId, [...transactionIds]),
        visibleTo(householdId),
      ),
    )
    .orderBy(asc(transactionTags.transactionId), asc(sql`lower(${tags.name})`), asc(tags.id));
  for (const r of rows) {
    const list = out.get(r.transactionId) ?? [];
    list.push({ id: r.id, name: r.name, color: r.color });
    out.set(r.transactionId, list);
  }
  return out;
}
