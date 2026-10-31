import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { type Db, type Tx, withRlsOn } from "@/db";
import { announcements, appErrors, feedback, users } from "@/db/schema";
import { pgErrorInfo } from "@/db/pg-errors";
import { NotFoundError } from "@/lib/authz";
import { ValidationError } from "@/lib/errors";
import { type AuditEvent, currentHouseholdIdOf, insertAudit } from "@/modules/auth/audit";
import { parseInput } from "@/modules/ledger/input";

import {
  type AnnouncementCreate,
  type AnnouncementUpdate,
  type ErrorReport,
  adminPageSchema,
  announcementCreateSchema,
  announcementUpdateSchema,
  errorReportSchema,
  feedbackCreateSchema,
  feedbackStatusSchema,
  userStatusSchema,
} from "./admin.schema";

/**
 * Feedback, anunțuri, erori și panoul de administrare (Faza 11-B, ADR 0028). Fiecare funcție de
 * administrare verifică ÎNTÂI administratorul platformei și, dacă utilizatorul nu e, răspunde cu
 * `NotFoundError` (404 uniform: nu se dezvăluie că există un panou). Citirile administratorului
 * trec prin politicile RLS și prin funcțiile SECURITY DEFINER din `0020`, care nu expun nicio dată
 * financiară. Acțiunile care schimbă ceva se auditează (în gospodăria curentă a administratorului),
 * doar cu id-ul țintei și starea nouă.
 */

async function requireAdmin(tx: Tx): Promise<void> {
  const rows = await tx.execute<{ ok: boolean }>(sql`select finet.is_platform_admin() as ok`);
  if (rows[0]?.ok !== true) throw new NotFoundError();
}

async function audit(tx: Tx, userId: string, event: AuditEvent): Promise<void> {
  const householdId = await currentHouseholdIdOf(tx, userId);
  if (householdId) await insertAudit(tx, userId, householdId, event);
}

// --- Feedback și anunțuri pentru utilizatori -----------------------------------------------------

export async function createFeedback(
  db: Db,
  userId: string,
  raw: unknown,
): Promise<{ id: string }> {
  const input = parseInput(feedbackCreateSchema, raw);
  return withRlsOn(db, { userId }, async (tx) => {
    const [row] = await tx
      .insert(feedback)
      .values({
        userId,
        kind: input.kind,
        message: input.message,
        page: input.page ?? null,
        appVersion: input.appVersion ?? null,
      })
      .returning({ id: feedback.id });
    return { id: row!.id };
  });
}

export type AnnouncementView = Readonly<{
  id: string;
  title: string;
  body: string;
  level: "info" | "warn";
  startsAt: string;
  endsAt: string | null;
}>;

const announcementView = (r: typeof announcements.$inferSelect): AnnouncementView => ({
  id: r.id,
  title: r.title,
  body: r.body,
  level: r.level,
  startsAt: r.startsAt.toISOString(),
  endsAt: r.endsAt ? r.endsAt.toISOString() : null,
});

/** Anunțurile active (politica RLS le filtrează: nearhivate, începute, neexpirate). */
export async function listActiveAnnouncements(db: Db, userId: string): Promise<AnnouncementView[]> {
  return withRlsOn(db, { userId }, async (tx) => {
    const rows = await tx
      .select()
      .from(announcements)
      .where(
        and(
          eq(announcements.archived, false),
          sql`${announcements.startsAt} <= now() and (${announcements.endsAt} is null or ${announcements.endsAt} > now())`,
        ),
      )
      .orderBy(desc(announcements.startsAt))
      .limit(5);
    return rows.map(announcementView);
  });
}

/** Raportarea unei erori (fără sesiune obligatorie; nu aruncă pentru valori invalide: se ignoră). */
export async function recordAppError(db: Db, userId: string | null, raw: unknown): Promise<void> {
  const parsed = errorReportSchema.safeParse(raw);
  if (!parsed.success) return;
  const e: ErrorReport = parsed.data;
  await withRlsOn(db, { userId }, (tx) =>
    tx.execute(
      sql`select finet.record_app_error(${e.kind}, ${e.route}, ${e.code}, ${e.digest ?? null}, ${e.appVersion ?? null})`,
    ),
  );
}

// --- Panoul de administrare --------------------------------------------------------------------

export async function isAdmin(db: Db, userId: string): Promise<boolean> {
  return withRlsOn(db, { userId }, async (tx) => {
    const rows = await tx.execute<{ ok: boolean }>(sql`select finet.is_platform_admin() as ok`);
    return rows[0]?.ok === true;
  });
}

type Page = Readonly<{ limit: number; offset: number; status?: "new" | "seen" | "closed" }>;
const pageOf = (raw: unknown): Page => {
  const q = parseInput(adminPageSchema, raw) ?? {};
  return { limit: q.limit ?? 50, offset: q.offset ?? 0, ...(q.status ? { status: q.status } : {}) };
};

export async function adminUsers(db: Db, userId: string, rawQuery: unknown = {}) {
  const page = pageOf(rawQuery);
  return withRlsOn(db, { userId }, async (tx) => {
    await requireAdmin(tx);
    const rows = await tx.execute<{
      id: string;
      email: string;
      name: string;
      status: string;
      is_platform_admin: boolean;
      created_at: Date;
      households: number;
    }>(sql`select * from finet.admin_users(${page.limit}, ${page.offset})`);
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      status: r.status,
      isPlatformAdmin: r.is_platform_admin,
      createdAt: new Date(r.created_at).toISOString(),
      households: Number(r.households),
    }));
  });
}

export async function adminHouseholds(db: Db, userId: string, rawQuery: unknown = {}) {
  const page = pageOf(rawQuery);
  return withRlsOn(db, { userId }, async (tx) => {
    await requireAdmin(tx);
    const rows = await tx.execute<{ id: string; name: string; members: number; created_at: Date }>(
      sql`select * from finet.admin_households(${page.limit}, ${page.offset})`,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      members: Number(r.members),
      createdAt: new Date(r.created_at).toISOString(),
    }));
  });
}

export async function adminJobs(db: Db, userId: string) {
  return withRlsOn(db, { userId }, async (tx) => {
    await requireAdmin(tx);
    const rows = await tx.execute<{ name: string; state: string; jobs: string }>(
      sql`select * from finet.admin_jobs()`,
    );
    return rows.map((r) => ({ name: r.name, state: r.state, jobs: Number(r.jobs) }));
  });
}

export async function adminSetUserStatus(
  db: Db,
  adminId: string,
  targetId: string,
  raw: unknown,
): Promise<{ changed: boolean }> {
  const { status } = parseInput(userStatusSchema, raw);
  try {
    return await withRlsOn(db, { userId: adminId }, async (tx) => {
      await requireAdmin(tx);
      if (targetId === adminId) {
        throw new ValidationError({ id: "Nu îți poți schimba propriul cont." });
      }
      const rows = await tx.execute<{ changed: boolean }>(
        sql`select finet.admin_set_user_status(${targetId}::uuid, ${status}) as changed`,
      );
      const changed = rows[0]?.changed === true;
      if (!changed) throw new NotFoundError();
      await audit(tx, adminId, {
        action: "admin.user_status_changed",
        targetType: "user",
        targetId,
        metadata: { status },
      });
      return { changed };
    });
  } catch (error) {
    // Funcția refuză (22023) orice schimbare de stare pe un administrator al platformei (0022).
    if (pgErrorInfo(error)?.code === "22023") {
      throw new ValidationError({ id: "Starea unui administrator o schimbă doar operatorul." });
    }
    throw error;
  }
}

export async function adminFeedback(db: Db, userId: string, rawQuery: unknown = {}) {
  const page = pageOf(rawQuery);
  return withRlsOn(db, { userId }, async (tx) => {
    await requireAdmin(tx);
    const rows = await tx
      .select({
        id: feedback.id,
        kind: feedback.kind,
        message: feedback.message,
        page: feedback.page,
        appVersion: feedback.appVersion,
        status: feedback.status,
        createdAt: feedback.createdAt,
        authorEmail: users.email,
      })
      .from(feedback)
      .innerJoin(users, eq(users.id, feedback.userId))
      .where(page.status ? eq(feedback.status, page.status) : undefined)
      .orderBy(desc(feedback.createdAt), desc(feedback.id))
      .limit(page.limit)
      .offset(page.offset);
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  });
}

export async function adminSetFeedbackStatus(db: Db, userId: string, id: string, raw: unknown) {
  const { status } = parseInput(feedbackStatusSchema, raw);
  return withRlsOn(db, { userId }, async (tx) => {
    await requireAdmin(tx);
    const rows = await tx
      .update(feedback)
      .set({ status, updatedAt: new Date() })
      .where(eq(feedback.id, id))
      .returning({ id: feedback.id });
    if (rows.length === 0) throw new NotFoundError();
    await audit(tx, userId, {
      action: "admin.feedback_status_changed",
      targetType: "feedback",
      targetId: id,
      metadata: { status },
    });
    return { id, status };
  });
}

export async function adminAnnouncements(db: Db, userId: string) {
  return withRlsOn(db, { userId }, async (tx) => {
    await requireAdmin(tx);
    const rows = await tx
      .select()
      .from(announcements)
      .orderBy(desc(announcements.createdAt))
      .limit(100);
    return rows.map((r) => ({ ...announcementView(r), archived: r.archived }));
  });
}

export async function adminCreateAnnouncement(db: Db, userId: string, raw: unknown) {
  const input: AnnouncementCreate = parseInput(announcementCreateSchema, raw);
  return withRlsOn(db, { userId }, async (tx) => {
    await requireAdmin(tx);
    const [row] = await tx
      .insert(announcements)
      .values({
        title: input.title,
        body: input.body,
        level: input.level,
        ...(input.startsAt ? { startsAt: new Date(input.startsAt) } : {}),
        endsAt: input.endsAt ? new Date(input.endsAt) : null,
        createdByUserId: userId,
      })
      .returning();
    await audit(tx, userId, {
      action: "admin.announcement_created",
      targetType: "announcement",
      targetId: row!.id,
      metadata: { level: input.level },
    });
    return announcementView(row!);
  });
}

export async function adminUpdateAnnouncement(db: Db, userId: string, id: string, raw: unknown) {
  const input: AnnouncementUpdate = parseInput(announcementUpdateSchema, raw);
  return withRlsOn(db, { userId }, async (tx) => {
    await requireAdmin(tx);
    const [row] = await tx
      .update(announcements)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.level !== undefined ? { level: input.level } : {}),
        ...(input.endsAt !== undefined
          ? { endsAt: input.endsAt === null ? null : new Date(input.endsAt) }
          : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
      })
      .where(eq(announcements.id, id))
      .returning();
    if (!row) throw new NotFoundError();
    await audit(tx, userId, {
      action: "admin.announcement_updated",
      targetType: "announcement",
      targetId: id,
      metadata: { archived: row.archived },
    });
    return announcementView(row);
  });
}

export async function adminErrors(db: Db, userId: string) {
  return withRlsOn(db, { userId }, async (tx) => {
    await requireAdmin(tx);
    const rows = await tx.select().from(appErrors).orderBy(desc(appErrors.lastSeenAt)).limit(100);
    return rows.map((r) => ({
      kind: r.kind,
      route: r.route,
      code: r.code,
      digest: r.digest,
      appVersion: r.appVersion,
      occurrences: r.occurrences,
      firstSeenAt: r.firstSeenAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
    }));
  });
}
