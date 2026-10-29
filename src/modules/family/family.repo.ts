import "server-only";

import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import {
  householdInvites,
  householdMembers,
  settlements,
  transactionSplits,
  userPreferences,
  users,
} from "@/db/schema";
import type { HouseholdRole } from "@/lib/authz";
import type { Currency } from "@/lib/money";

import type { InviteStatus, InviteView, MemberView, SettlementView } from "./family.schema";
import type { SettlementRow, SplitRow } from "./split-math";

/**
 * Accesul la date al familiei (Faza 8). Toate interogările rulează în tranzacția deschisă de
 * serviciu cu contextul RLS al gospodăriei (`withMember`), deci politicile din 0012 se aplică
 * și aici; filtrul explicit pe `household_id` e apărare în adâncime.
 */

// --- invitații --------------------------------------------------------------------------------

const inviteColumns = {
  id: householdInvites.id,
  role: householdInvites.role,
  createdByUserId: householdInvites.createdByUserId,
  createdAt: householdInvites.createdAt,
  expiresAt: householdInvites.expiresAt,
  usedAt: householdInvites.usedAt,
  usedByUserId: householdInvites.usedByUserId,
  revokedAt: householdInvites.revokedAt,
} as const;

type InviteRow = Omit<InviteView, "status">;

export function inviteStatus(row: InviteRow, now: Date): InviteStatus {
  if (row.usedAt) return "used";
  if (row.revokedAt) return "revoked";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

/** Serializează crearea invitațiilor unei gospodării (limita zilnică fără curse). */
export async function lockHouseholdInvites(tx: Tx, householdId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`finet.household_invites:${householdId}`}))`,
  );
}

export async function countInvitesSince(tx: Tx, householdId: string, since: Date) {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(householdInvites)
    .where(
      and(eq(householdInvites.householdId, householdId), gt(householdInvites.createdAt, since)),
    );
  return rows[0]?.n ?? 0;
}

export async function insertInvite(
  tx: Tx,
  values: Readonly<{
    householdId: string;
    tokenHash: string;
    role: HouseholdRole;
    createdByUserId: string;
    expiresAt: Date;
  }>,
): Promise<InviteRow> {
  // INSERT cu listă explicită de coloane: aplicația are drept de INSERT doar pe ele (`created_at`
  // îl pune baza, `used_*`/`revoked_at` rămân NULL); fără RETURNING pe `token_hash`.
  const rows = await tx.execute<{ id: string }>(sql`
    insert into finet.household_invites
      (household_id, token_hash, role, created_by_user_id, expires_at)
    values (${values.householdId}, ${values.tokenHash}, ${values.role},
            ${values.createdByUserId}, ${values.expiresAt.toISOString()})
    returning id`);
  const [row] = await tx
    .select(inviteColumns)
    .from(householdInvites)
    .where(eq(householdInvites.id, rows[0]!.id));
  return row!;
}

export async function selectInvites(tx: Tx, householdId: string): Promise<InviteRow[]> {
  return tx
    .select(inviteColumns)
    .from(householdInvites)
    .where(eq(householdInvites.householdId, householdId))
    .orderBy(desc(householdInvites.createdAt), desc(householdInvites.id))
    .limit(100);
}

export async function selectInvite(tx: Tx, householdId: string, id: string) {
  const rows = await tx
    .select(inviteColumns)
    .from(householdInvites)
    .where(and(eq(householdInvites.householdId, householdId), eq(householdInvites.id, id)))
    .limit(1)
    .for("update");
  return rows[0] ?? null;
}

export async function revokeInviteRow(tx: Tx, householdId: string, id: string, now: Date) {
  const rows = await tx
    .update(householdInvites)
    .set({ revokedAt: now })
    .where(
      and(
        eq(householdInvites.householdId, householdId),
        eq(householdInvites.id, id),
        isNull(householdInvites.usedAt),
        isNull(householdInvites.revokedAt),
      ),
    )
    .returning(inviteColumns);
  return rows[0] ?? null;
}

/** `finet.accept_invite`: gospodăria și dacă a fost o intrare nouă, sau `null` (uniform). */
export async function acceptInviteRow(
  tx: Tx,
  tokenHash: string,
): Promise<{ householdId: string; joined: boolean } | null> {
  const rows = await tx.execute<{ invite_household_id: string; newly_joined: boolean }>(
    sql`select invite_household_id, newly_joined from finet.accept_invite(${tokenHash})`,
  );
  const row = rows[0];
  return row ? { householdId: row.invite_household_id, joined: row.newly_joined } : null;
}

// --- membri -----------------------------------------------------------------------------------

export async function selectMembers(tx: Tx, householdId: string): Promise<MemberView[]> {
  return tx
    .select({
      userId: householdMembers.userId,
      name: users.name,
      role: householdMembers.role,
      joinedAt: householdMembers.joinedAt,
    })
    .from(householdMembers)
    .innerJoin(users, eq(users.id, householdMembers.userId))
    .where(eq(householdMembers.householdId, householdId))
    .orderBy(asc(householdMembers.joinedAt), asc(householdMembers.userId));
}

export async function selectMember(tx: Tx, householdId: string, userId: string) {
  const rows = await tx
    .select({ id: householdMembers.id, role: householdMembers.role })
    .from(householdMembers)
    .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Serializează schimbările de membri ale gospodăriei (același lock ca triggerele din 0012). */
export async function lockHouseholdMembers(tx: Tx, householdId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`finet.household_members:${householdId}`}))`,
  );
}

export async function updateMemberRole(
  tx: Tx,
  householdId: string,
  userId: string,
  role: HouseholdRole,
): Promise<boolean> {
  const rows = await tx
    .update(householdMembers)
    .set({ role })
    .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.userId, userId)))
    .returning({ id: householdMembers.id });
  return rows.length > 0;
}

export async function deleteMember(tx: Tx, householdId: string, userId: string) {
  const rows = await tx
    .delete(householdMembers)
    .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.userId, userId)))
    .returning({ id: householdMembers.id });
  return rows[0]?.id ?? null;
}

// --- gospodăria activă ------------------------------------------------------------------------

export async function setActiveHouseholdRow(
  tx: Tx,
  userId: string,
  householdId: string | null,
): Promise<void> {
  await tx
    .insert(userPreferences)
    .values({ userId, activeHouseholdId: householdId })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { activeHouseholdId: householdId, updatedAt: new Date() },
    });
}

/** Șterge preferința dacă indică gospodăria dată (după plecare). */
export async function clearActiveHouseholdIf(
  tx: Tx,
  userId: string,
  householdId: string,
): Promise<void> {
  await tx
    .update(userPreferences)
    .set({ activeHouseholdId: null })
    .where(
      and(eq(userPreferences.userId, userId), eq(userPreferences.activeHouseholdId, householdId)),
    );
}

// --- împărțiri --------------------------------------------------------------------------------

export type SplitDbRow = SplitRow & Readonly<{ transactionId: string; createdAt: Date }>;

const splitColumns = {
  transactionId: transactionSplits.transactionId,
  payerUserId: transactionSplits.payerUserId,
  userId: transactionSplits.userId,
  shareMinor: transactionSplits.shareMinor,
  currency: transactionSplits.currency,
  createdAt: transactionSplits.createdAt,
} as const;

export async function selectSplitRows(
  tx: Tx,
  householdId: string,
  transactionIds?: readonly string[],
): Promise<SplitDbRow[]> {
  const where = transactionIds
    ? and(
        eq(transactionSplits.householdId, householdId),
        inArray(transactionSplits.transactionId, [...transactionIds]),
      )
    : eq(transactionSplits.householdId, householdId);
  return tx
    .select(splitColumns)
    .from(transactionSplits)
    .where(where)
    .orderBy(asc(transactionSplits.transactionId), asc(transactionSplits.userId));
}

/** Ultimele tranzacții împărțite (id-uri), cele mai noi întâi. */
export async function selectRecentSplitTransactionIds(
  tx: Tx,
  householdId: string,
  limit: number,
): Promise<string[]> {
  const rows = await tx
    .select({
      transactionId: transactionSplits.transactionId,
      at: sql<Date>`max(${transactionSplits.createdAt})`,
    })
    .from(transactionSplits)
    .where(eq(transactionSplits.householdId, householdId))
    .groupBy(transactionSplits.transactionId)
    .orderBy(desc(sql`max(${transactionSplits.createdAt})`), desc(transactionSplits.transactionId))
    .limit(limit);
  return rows.map((r) => r.transactionId);
}

export async function deleteSplitRows(tx: Tx, householdId: string, transactionId: string) {
  const rows = await tx
    .delete(transactionSplits)
    .where(
      and(
        eq(transactionSplits.householdId, householdId),
        eq(transactionSplits.transactionId, transactionId),
      ),
    )
    .returning({ id: transactionSplits.id });
  return rows.length;
}

export async function insertSplitRows(
  tx: Tx,
  rows: ReadonlyArray<{
    householdId: string;
    transactionId: string;
    payerUserId: string;
    userId: string;
    shareMinor: bigint;
    currency: Currency;
  }>,
): Promise<void> {
  if (rows.length > 0) await tx.insert(transactionSplits).values([...rows]);
}

// --- decontări --------------------------------------------------------------------------------

const settlementColumns = {
  id: settlements.id,
  fromUserId: settlements.fromUserId,
  toUserId: settlements.toUserId,
  amountMinor: settlements.amountMinor,
  currency: settlements.currency,
  settledOn: settlements.settledOn,
  note: settlements.note,
  createdByUserId: settlements.createdByUserId,
  createdAt: settlements.createdAt,
  cancelledAt: settlements.cancelledAt,
  cancelledByUserId: settlements.cancelledByUserId,
} as const;

export async function insertSettlement(
  tx: Tx,
  values: Readonly<{
    householdId: string;
    fromUserId: string;
    toUserId: string;
    amountMinor: bigint;
    currency: Currency;
    settledOn: string;
    note: string | null;
    createdByUserId: string;
  }>,
): Promise<SettlementView> {
  // Listă explicită de coloane (drepturi de INSERT pe coloane; `created_at` și anularea nu se
  // pot seta la creare).
  const rows = await tx.execute<{ id: string }>(sql`
    insert into finet.settlements
      (household_id, from_user_id, to_user_id, amount_minor, currency, settled_on, note,
       created_by_user_id)
    values (${values.householdId}, ${values.fromUserId}, ${values.toUserId},
            ${values.amountMinor.toString()}::bigint, ${values.currency}, ${values.settledOn}::date,
            ${values.note}, ${values.createdByUserId})
    returning id`);
  const [row] = await tx
    .select(settlementColumns)
    .from(settlements)
    .where(eq(settlements.id, rows[0]!.id));
  return row!;
}

export async function selectSettlements(
  tx: Tx,
  householdId: string,
  options: Readonly<{ includeCancelled: boolean; limit?: number }>,
): Promise<SettlementView[]> {
  const where = options.includeCancelled
    ? eq(settlements.householdId, householdId)
    : and(eq(settlements.householdId, householdId), isNull(settlements.cancelledAt));
  const q = tx
    .select(settlementColumns)
    .from(settlements)
    .where(where)
    .orderBy(desc(settlements.settledOn), desc(settlements.createdAt), desc(settlements.id));
  return options.limit === undefined ? q : q.limit(options.limit);
}

export async function selectSettlement(tx: Tx, householdId: string, id: string) {
  const rows = await tx
    .select(settlementColumns)
    .from(settlements)
    .where(and(eq(settlements.householdId, householdId), eq(settlements.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function cancelSettlementRow(
  tx: Tx,
  householdId: string,
  id: string,
  actorUserId: string,
  now: Date,
): Promise<SettlementView | null> {
  const rows = await tx
    .update(settlements)
    .set({ cancelledAt: now, cancelledByUserId: actorUserId })
    .where(
      and(
        eq(settlements.householdId, householdId),
        eq(settlements.id, id),
        isNull(settlements.cancelledAt),
      ),
    )
    .returning(settlementColumns);
  return rows[0] ?? null;
}

/** Decontările active, ca rânduri pentru calculul soldurilor. */
export async function selectActiveSettlementRows(
  tx: Tx,
  householdId: string,
): Promise<SettlementRow[]> {
  return tx
    .select({
      fromUserId: settlements.fromUserId,
      toUserId: settlements.toUserId,
      amountMinor: settlements.amountMinor,
      currency: settlements.currency,
    })
    .from(settlements)
    .where(and(eq(settlements.householdId, householdId), isNull(settlements.cancelledAt)));
}
