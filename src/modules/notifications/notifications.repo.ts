import "server-only";

import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import { documents, notificationPreferences, notifications, statementUploads } from "@/db/schema";

/** Accesul la date al notificărilor (ADR 0048), sub RLS (rândurile proprii ale utilizatorului). */

export type NotificationRow = typeof notifications.$inferSelect;
export type PreferencesRow = typeof notificationPreferences.$inferSelect;

export async function selectNotifications(
  tx: Tx,
  userId: string,
  householdId: string,
  options: Readonly<{ unreadOnly: boolean; limit: number }>,
): Promise<NotificationRow[]> {
  const conds = [eq(notifications.userId, userId), eq(notifications.householdId, householdId)];
  if (options.unreadOnly) conds.push(isNull(notifications.readAt));
  return tx
    .select()
    .from(notifications)
    .where(and(...conds))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(options.limit);
}

export async function countUnread(tx: Tx, userId: string, householdId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.householdId, householdId),
        isNull(notifications.readAt),
      ),
    );
  return Number(row?.n ?? 0);
}

export async function markRead(
  tx: Tx,
  userId: string,
  householdId: string,
  id: string | null,
  at: Date,
): Promise<number> {
  const conds = [
    eq(notifications.userId, userId),
    eq(notifications.householdId, householdId),
    isNull(notifications.readAt),
  ];
  if (id) conds.push(eq(notifications.id, id));
  const rows = await tx
    .update(notifications)
    .set({ readAt: at })
    .where(and(...conds))
    .returning({ id: notifications.id });
  return rows.length;
}

export async function deleteNotification(
  tx: Tx,
  userId: string,
  householdId: string,
  id: string,
): Promise<boolean> {
  const rows = await tx
    .delete(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.householdId, householdId),
        eq(notifications.id, id),
      ),
    )
    .returning({ id: notifications.id });
  return rows.length > 0;
}

/** Inserează candidații; cei cu `dedup_key` deja existent sunt ignorați. Întoarce câți au intrat. */
export async function insertNotifications(
  tx: Tx,
  rows: readonly (typeof notifications.$inferInsert)[],
): Promise<NotificationRow[]> {
  if (rows.length === 0) return [];
  return tx
    .insert(notifications)
    .values([...rows])
    .onConflictDoNothing({ target: [notifications.userId, notifications.dedupKey] })
    .returning();
}

/** Notificările proprii netrimise pe email (pentru digestul zilnic). */
export async function selectUnemailed(
  tx: Tx,
  userId: string,
  householdId: string,
  limit: number,
): Promise<NotificationRow[]> {
  return tx
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.householdId, householdId),
        isNull(notifications.emailedAt),
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

export async function markEmailed(tx: Tx, ids: readonly string[], at: Date): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(notifications)
    .set({ emailedAt: at })
    .where(sql`${notifications.id} in ${ids}`);
}

export async function selectPreferences(tx: Tx, userId: string): Promise<PreferencesRow | null> {
  const [row] = await tx
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));
  return row ?? null;
}

export async function upsertPreferences(
  tx: Tx,
  userId: string,
  patch: Readonly<{ inApp?: boolean; email?: boolean; kinds?: readonly string[] }>,
): Promise<PreferencesRow> {
  const [row] = await tx
    .insert(notificationPreferences)
    .values({
      userId,
      ...(patch.inApp === undefined ? {} : { inApp: patch.inApp }),
      ...(patch.email === undefined ? {} : { email: patch.email }),
      ...(patch.kinds === undefined ? {} : { kinds: [...patch.kinds] }),
    })
    .onConflictDoUpdate({
      target: notificationPreferences.userId,
      set: {
        ...(patch.inApp === undefined ? {} : { inApp: patch.inApp }),
        ...(patch.email === undefined ? {} : { email: patch.email }),
        ...(patch.kinds === undefined ? {} : { kinds: [...patch.kinds] }),
        updatedAt: new Date(),
      },
    })
    .returning();
  return row!;
}

/** Documentele și extrasele eșuate de la `since` încoace (doar id-uri). */
export async function selectRecentFailures(
  tx: Tx,
  householdId: string,
  since: Date,
): Promise<{ id: string; kind: "receipt" | "statement" }[]> {
  const docs = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.householdId, householdId),
        eq(documents.status, "failed"),
        gte(documents.updatedAt, since),
      ),
    )
    .limit(20);
  const uploads = await tx
    .select({ id: statementUploads.id })
    .from(statementUploads)
    .where(
      and(
        eq(statementUploads.householdId, householdId),
        eq(statementUploads.status, "failed"),
        gte(statementUploads.updatedAt, since),
      ),
    )
    .limit(20);
  return [
    ...docs.map((d) => ({ id: d.id, kind: "receipt" as const })),
    ...uploads.map((u) => ({ id: u.id, kind: "statement" as const })),
  ];
}
