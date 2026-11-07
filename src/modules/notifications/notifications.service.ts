import "server-only";

import { sql } from "drizzle-orm";

import { type DbOrTx, withRlsOn } from "@/db";
import { users } from "@/db/schema";
import { type Actor, NotFoundError } from "@/lib/authz";
import { DEFAULT_TIME_ZONE, addMonths, currentMonth, localDateOf } from "@/lib/calendar";
import type { Currency } from "@/lib/money";
import { ro } from "@/messages/ro";
import { getAdvice } from "@/modules/advisor/advisor.service";
import type { Mailer } from "@/modules/auth/mailer";
import { selectHouseholdTimeZone } from "@/modules/budgets/budgets.repo";
import { type PlanningDeps, getBudgetStatuses } from "@/modules/budgets/budgets.service";
import { categoryNames } from "@/modules/dashboard/dashboard.service";
import { getForecast } from "@/modules/forecast/forecast.service";
import { getSavingsPlan } from "@/modules/goals/plan.service";
import { inHousehold } from "@/modules/ledger/context";
import { parseInput } from "@/modules/ledger/input";
import { getSubscriptions } from "@/modules/subscriptions/subscriptions.service";
import { getMonthlySummary } from "@/modules/summary/summary.service";

import {
  type NotificationRow,
  type PreferencesRow,
  countUnread,
  deleteNotification,
  insertNotifications,
  markEmailed,
  markRead,
  selectNotifications,
  selectPreferences,
  selectRecentFailures,
  selectUnemailed,
  upsertPreferences,
} from "./notifications.repo";
import {
  NOTIFICATIONS_LIMIT_DEFAULT,
  notificationsListSchema,
  preferencesPutSchema,
} from "./notifications.schema";
import {
  type Candidate,
  applyPreferences,
  budgetAlerts,
  goalReminders,
  monthlySummary,
  paymentsDue,
  subscriptionRenewals,
  syncFailures,
  unusualSpending,
} from "./rules";

/**
 * Notificările (ADR 0048). Citirile și marcajele rulează sub `withMember` + RLS (rândurile
 * proprii). Evaluarea (`evaluateForMember`) rulează în worker, în numele fiecărui membru activ
 * (`finet.notification_targets`), compune candidații din serviciile existente (prognoză, bugete,
 * consilier, plan, abonamente, rezumat, documente), îi filtrează după preferințe și îi inserează
 * cu `dedup_key` (cei existenți sunt ignorați). Emailul: un digest cu rândurile netrimise, doar
 * cu `email = true`; fără SMTP nu se trimite nimic și nimic nu se marchează.
 */

const EMAIL_DIGEST_LIMIT = 20;
const FAILURE_LOOKBACK_MS = 36 * 3600 * 1000;

export async function listNotifications(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  rawQuery: unknown = {},
): Promise<Readonly<{ data: NotificationRow[]; unread: number }>> {
  const query = parseInput(notificationsListSchema, rawQuery) ?? {};
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const data = await selectNotifications(tx, actor.userId, m.householdId, {
      unreadOnly: query.unread ?? false,
      limit: query.limit ?? NOTIFICATIONS_LIMIT_DEFAULT,
    });
    const unread = await countUnread(tx, actor.userId, m.householdId);
    return { data, unread };
  });
}

export async function unreadCount(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
): Promise<number> {
  return inHousehold(deps, actor, householdId, (tx, m) =>
    countUnread(tx, actor.userId, m.householdId),
  );
}

export async function markNotificationRead(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  id: string,
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  await inHousehold(deps, actor, householdId, async (tx, m) => {
    const n = await markRead(tx, actor.userId, m.householdId, id, now());
    if (n === 0) {
      // Fie nu există (404), fie e deja citită (idempotent): verificăm existența.
      const rows = await selectNotifications(tx, actor.userId, m.householdId, {
        unreadOnly: false,
        limit: 1,
      });
      if (!rows.some((r) => r.id === id)) {
        const [exists] = await tx.execute<{ ok: boolean }>(
          sql`select true as ok from finet.notifications where id = ${id}::uuid and user_id = ${actor.userId}::uuid limit 1`,
        );
        if (!exists) throw new NotFoundError();
      }
    }
  });
}

export async function markAllRead(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
): Promise<number> {
  const now = deps.now ?? (() => new Date());
  return inHousehold(deps, actor, householdId, (tx, m) =>
    markRead(tx, actor.userId, m.householdId, null, now()),
  );
}

export async function removeNotification(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  id: string,
): Promise<void> {
  await inHousehold(deps, actor, householdId, async (tx, m) => {
    const ok = await deleteNotification(tx, actor.userId, m.householdId, id);
    if (!ok) throw new NotFoundError();
  });
}

export async function getPreferences(db: DbOrTx, userId: string): Promise<PreferencesRow | null> {
  return withRlsOn(db, { userId }, (tx) => selectPreferences(tx, userId));
}

export async function setPreferences(
  db: DbOrTx,
  userId: string,
  rawBody: unknown,
): Promise<PreferencesRow> {
  const patch = parseInput(preferencesPutSchema, rawBody);
  return withRlsOn(db, { userId }, (tx) => upsertPreferences(tx, userId, patch));
}

// ---------------------------------------------------------------------------------------------
// Evaluarea (worker)
// ---------------------------------------------------------------------------------------------

export type EvaluateResult = Readonly<{
  candidates: number;
  inserted: number;
  emailed: number;
  skipped: "preferences_off" | null;
}>;

export type EvaluateOptions = Readonly<{
  /** Expeditorul de email (`null` = fără email). */
  mailer: Mailer | null;
  /** Adresa publică a aplicației, pentru linkurile din email (`null` = fără linkuri). */
  appUrl: string | null;
}>;

/** Candidații unui membru, din serviciile existente, în contextul lui RLS. */
export async function candidatesForMember(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
): Promise<Candidate[]> {
  const now = deps.now ?? (() => new Date());
  const { tz, failures, names } = await inHousehold(deps, actor, householdId, async (tx, m) => ({
    tz: (await selectHouseholdTimeZone(tx, m.householdId)) ?? DEFAULT_TIME_ZONE,
    failures: await selectRecentFailures(
      tx,
      m.householdId,
      new Date(now().getTime() - FAILURE_LOOKBACK_MS),
    ),
    names: await categoryNames(tx, m.householdId),
  }));
  const instant = now();
  const today = localDateOf(instant, tz);
  const month = currentMonth(instant, tz);
  const out: Candidate[] = [];

  const forecast = await getForecast(deps, actor, householdId, { days: 30 });
  for (const f of forecast.currencies) out.push(...paymentsDue(f.upcoming, f.currency, today));

  const budgets = await getBudgetStatuses(deps, actor, householdId, { month });
  out.push(
    ...budgetAlerts(
      budgets.map((b) => ({
        id: b.id,
        name: b.categoryId ? (names.get(b.categoryId) ?? "—") : ro.budgets.generalShort,
        status: b.status,
        spentMinor: b.spentMinor,
        amountMinor: b.amountMinor,
        currency: b.currency as Currency,
      })),
      month,
    ),
  );

  const advice = await getAdvice(deps, actor, householdId, { month });
  for (const a of advice.currencies) out.push(...unusualSpending(a.unusual, a.currency, month));

  const plan = await getSavingsPlan(deps, actor, householdId);
  out.push(...goalReminders(plan.goals));

  const subs = await getSubscriptions(deps, actor, householdId);
  for (const s of subs.currencies) out.push(...subscriptionRenewals(s.upcoming));

  if (today.endsWith("-01")) {
    const summary = await getMonthlySummary(deps, actor, householdId, {
      month: addMonths(month, -1),
    });
    out.push(...monthlySummary(summary));
  }

  out.push(...syncFailures(failures));
  return out;
}

export async function evaluateForMember(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  options: EvaluateOptions,
): Promise<EvaluateResult> {
  const now = deps.now ?? (() => new Date());
  const prefsRow = await getPreferences(deps.db, actor.userId);
  const prefs = {
    inApp: prefsRow?.inApp ?? true,
    email: prefsRow?.email ?? false,
    kinds: prefsRow?.kinds ?? [],
  };
  if (!prefsRow) prefs.kinds = [...(await import("@/db/schema")).NOTIFICATION_KINDS];
  if (!prefs.inApp) return { candidates: 0, inserted: 0, emailed: 0, skipped: "preferences_off" };

  const candidates = applyPreferences(await candidatesForMember(deps, actor, householdId), prefs);
  const inserted = await inHousehold(deps, actor, householdId, (tx, m) =>
    insertNotifications(
      tx,
      candidates.map((c) => ({
        householdId: m.householdId,
        userId: actor.userId,
        kind: c.kind,
        title: c.title,
        body: c.body,
        link: c.link,
        dedupKey: c.dedupKey,
      })),
    ),
  );

  let emailed = 0;
  if (prefs.email && options.mailer) {
    emailed = await inHousehold(deps, actor, householdId, async (tx, m) => {
      const pending = await selectUnemailed(tx, actor.userId, m.householdId, EMAIL_DIGEST_LIMIT);
      if (pending.length === 0) return 0;
      const [user] = await tx
        .select({ email: users.email, name: users.name })
        .from(users)
        .where(sql`${users.id} = ${actor.userId}::uuid`);
      if (!user?.email) return 0;
      const t = ro.notifications.email;
      const lines = pending.map(
        (n) =>
          `• ${n.title}\n  ${n.body}${n.link && options.appUrl ? `\n  ${options.appUrl}${n.link}` : ""}`,
      );
      const text = `${t.greeting(user.name)}\n\n${lines.join("\n\n")}\n\n${t.footer}`;
      const html = `<p>${escapeHtml(t.greeting(user.name))}</p>${pending
        .map(
          (n) =>
            `<p><strong>${escapeHtml(n.title)}</strong><br>${escapeHtml(n.body)}${n.link && options.appUrl ? `<br><a href="${escapeHtml(options.appUrl + n.link)}">${escapeHtml(t.open)}</a>` : ""}</p>`,
        )
        .join("")}<p>${escapeHtml(t.footer)}</p>`;
      await options.mailer!.send({
        to: user.email,
        subject: t.subject(pending.length),
        text,
        html,
      });
      await markEmailed(
        tx,
        pending.map((n) => n.id),
        now(),
      );
      return pending.length;
    });
  }
  return { candidates: candidates.length, inserted: inserted.length, emailed, skipped: null };
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Țintele evaluării zilnice: (gospodărie, membru activ), din funcția SECURITY DEFINER. */
export async function selectNotificationTargets(
  db: DbOrTx,
  limit: number,
): Promise<{ householdId: string; userId: string }[]> {
  const rows = await db.execute<{ household_id: string; user_id: string }>(
    sql`select household_id, user_id from finet.notification_targets(${limit})`,
  );
  return rows.map((r) => ({ householdId: r.household_id, userId: r.user_id }));
}
