import "server-only";

import { asc, eq, sql } from "drizzle-orm";

import { type Db, type Tx, withRlsOn } from "@/db";
import { auditEvents, householdMembers } from "@/db/schema";

/**
 * Jurnalul de audit al autentificării (6.1, 6.3): CINE (id), CE (acțiune tehnică), pe ce TIP
 * de obiect (id). Fără emailuri, IP-uri, user-agent sau alte date personale în `metadata`.
 *
 * `audit_events` aparține unei gospodării (RLS: actorul trebuie să fie membru al gospodăriei
 * curente). Evenimentele unui utilizator se scriu în gospodăria lui CURENTĂ (decizia mea, până
 * la comutarea între gospodării din Faza 8: cea mai veche apartenență, adică gospodăria
 * personală creată odată cu contul).
 */

export type AuditAction =
  | "auth.login_succeeded"
  | "auth.password_changed"
  | "auth.password_reset"
  | "auth.session_revoked"
  | "auth.sessions_revoked_others"
  | "user.created"
  | "household.member_added";

export type AuditEvent = Readonly<{
  action: AuditAction;
  targetType?: "user" | "session" | "household" | "household_member";
  targetId?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}>;

/** Gospodăria curentă a utilizatorului din contextul RLS (`null` dacă nu are niciuna). */
export async function currentHouseholdIdOf(tx: Tx, userId: string): Promise<string | null> {
  const rows = await tx
    .select({ householdId: householdMembers.householdId })
    .from(householdMembers)
    .where(eq(householdMembers.userId, userId))
    .orderBy(asc(householdMembers.joinedAt), asc(householdMembers.householdId))
    .limit(1);
  return rows[0]?.householdId ?? null;
}

/** Scrie evenimentul în tranzacția dată, pentru gospodăria indicată (context RLS setat aici). */
export async function insertAudit(
  tx: Tx,
  actorUserId: string,
  householdId: string,
  event: AuditEvent,
): Promise<void> {
  await tx.execute(sql`select set_config('app.household_id', ${householdId}, true)`);
  await tx.insert(auditEvents).values({
    householdId,
    actorUserId,
    action: event.action,
    targetType: event.targetType ?? null,
    targetId: event.targetId ?? null,
    metadata: event.metadata ?? {},
  });
}

/**
 * Scrie evenimentul în gospodăria curentă a actorului, în tranzacția lui proprie. Un utilizator
 * fără gospodărie nu are unde să fie auditat: evenimentul se omite (nu se aruncă).
 */
export async function recordAudit(db: Db, actorUserId: string, event: AuditEvent): Promise<void> {
  await withRlsOn(db, { userId: actorUserId }, async (tx) => {
    const householdId = await currentHouseholdIdOf(tx, actorUserId);
    if (householdId) await insertAudit(tx, actorUserId, householdId, event);
  });
}
