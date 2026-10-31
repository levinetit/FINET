import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

import { type Db, type Tx, withRlsOn } from "@/db";
import { auditEvents, householdMembers, userPreferences } from "@/db/schema";

/**
 * Jurnalul de audit al autentificării (6.1, 6.3): CINE (id), CE (acțiune tehnică), pe ce TIP
 * de obiect (id). Fără emailuri, IP-uri, user-agent sau alte date personale în `metadata`.
 *
 * `audit_events` aparține unei gospodării (RLS: actorul trebuie să fie membru al gospodăriei
 * curente). Evenimentele unui utilizator se scriu în gospodăria lui CURENTĂ: cea aleasă cu
 * comutatorul din Faza 8 (`user_preferences.active_household_id`), dacă e încă membru; altfel cea
 * mai veche apartenență (gospodăria personală creată odată cu contul).
 */

export type AuditAction =
  | "auth.login_succeeded"
  | "auth.password_changed"
  | "auth.password_reset"
  | "auth.session_revoked"
  | "auth.sessions_revoked_others"
  | "user.created"
  | "user.email_verified"
  | "household.member_added"
  // Familia (Faza 8): doar CINE, pe ce obiect și rolul; fără tokenuri, sume sau nume.
  | "household.invite_created"
  | "household.invite_revoked"
  | "household.invite_accepted"
  | "household.member_role_changed"
  | "household.member_removed"
  | "household.member_left"
  | "household.ownership_transferred"
  | "household.switched"
  | "transaction.split_set"
  | "transaction.split_cleared"
  | "settlement.created"
  | "settlement.cancelled"
  // Registrul (Faza 2): doar CINE și pe ce obiect, fără sume sau descrieri (5.6, 6.1).
  | "account.archived"
  | "account.unarchived"
  | "account.deleted"
  | "category.deleted"
  | "transaction.deleted"
  | "transfer.deleted"
  // Planificarea (Faza 3): fără nume, sume sau descrieri.
  | "tag.deleted"
  | "budget.deleted"
  | "goal.deleted"
  // Listele de cumpărături (Faza 10): doar id-ul și numărul de articole, fără nume sau conținut.
  | "shopping_list.deleted"
  // Recurențele (Faza 5): fără sume sau descrieri.
  | "recurring_rule.deleted"
  // Generarea la cerere (F5-B): doar contoare în `metadata`, fără sume sau reguli.
  | "recurring.generated"
  // Exporturile CSV (F3-B): doar tipul exportului și numărul de rânduri, fără conținut.
  | "export.downloaded"
  // Consimțămintele (F2-B, 6.5): doar tipul, în `metadata.kind`.
  // Documentele (Faza 6): doar contoare și id-ul documentului, fără nume de fișier sau conținut.
  | "document.uploaded"
  | "document.deleted"
  // Bonurile (F6-C): doar contoare și id-uri, fără sume, nume de produse sau comercianți.
  | "receipt.corrected"
  | "receipt.confirmed"
  | "receipt.reprocessed"
  | "receipt.deleted"
  | "documents.expired"
  // Extrasele (Faza 7): doar contoare și id-ul importului, fără sume, descrieri sau IBAN.
  | "statement.previewed"
  | "statement.imported"
  | "statement.cancelled"
  | "statement.discarded"
  // F7-B: încărcarea PDF (doar mărimea), renunțarea la ea, potrivirea bon ↔ tranzacție (fără
  // sume) și respingerea unei propuneri de plată recurentă.
  | "statement.uploaded"
  | "statement.upload_cancelled"
  | "receipt.matched"
  | "receipt.match_rejected"
  | "recurring.suggestion_dismissed"
  // Rapoartele de micro-cheltuieli (F10-B): doar CINE și id-ul definiției, fără nume sau reguli.
  | "report.created"
  | "report.updated"
  | "report.deleted"
  | "consent.granted"
  | "consent.revoked"
  // GDPR (F9-B): doar numărul de gospodării exportate, fără conținut.
  | "user.data_exported"
  // Panoul de administrare (Faza 11-B): doar id-ul țintei și starea nouă, fără conținut.
  | "admin.user_status_changed"
  | "admin.feedback_status_changed"
  | "admin.feedback_rewarded"
  | "admin.announcement_created"
  | "admin.announcement_updated";

export type AuditEvent = Readonly<{
  action: AuditAction;
  targetType?:
    | "feedback"
    | "announcement"
    | "user"
    | "session"
    | "household"
    | "household_member"
    | "household_invite"
    | "settlement"
    | "account"
    | "category"
    | "transaction"
    | "transfer"
    | "tag"
    | "budget"
    | "goal"
    | "shopping_list"
    | "recurring_rule"
    | "document"
    | "receipt"
    | "statement_import"
    | "statement_upload"
    | "report_definition";
  targetId?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}>;

/**
 * Gospodăria curentă a utilizatorului din contextul RLS (`null` dacă nu are niciuna): cea activă
 * aleasă de el (`user_preferences.active_household_id`), dacă apartenența EXISTĂ ÎN BAZĂ la
 * momentul cererii, altfel cea mai veche apartenență. Interogarea pornește mereu din
 * `household_members`, deci o preferință rămasă după plecare sau eliminare e ignorată: apartenența
 * se verifică la FIECARE cerere (Faza 8, comutatorul de gospodărie).
 */
export async function currentHouseholdIdOf(tx: Tx, userId: string): Promise<string | null> {
  const rows = await tx
    .select({ householdId: householdMembers.householdId })
    .from(householdMembers)
    .leftJoin(
      userPreferences,
      and(
        eq(userPreferences.userId, householdMembers.userId),
        eq(userPreferences.activeHouseholdId, householdMembers.householdId),
      ),
    )
    .where(eq(householdMembers.userId, userId))
    .orderBy(
      sql`(${userPreferences.userId} is null)`,
      asc(householdMembers.joinedAt),
      asc(householdMembers.householdId),
    )
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
