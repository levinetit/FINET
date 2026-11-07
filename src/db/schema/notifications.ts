import { sql } from "drizzle-orm";
import { boolean, check, index, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { users } from "./auth";
import { createdAt, finet, updatedAt } from "./finet";
import { households } from "./households";

/**
 * Modernizare 2026 — notificările (ADR 0048). Notificările sunt rânduri în aplicație, pe
 * utilizator și gospodărie, generate de workerul zilnic din datele existente (prognoză, bugete,
 * consilier, obiective, abonamente, rezumatul lunii, documente eșuate); `dedup_key` împiedică
 * repetarea aceleiași notificări. Fără conținut financiar sensibil în afara a ceea ce utilizatorul
 * vede oricum în paginile respective; `link` duce la pagina cu detaliile.
 *
 * Preferințele: ce tipuri primește utilizatorul (în aplicație) și dacă le vrea și pe email
 * (implicit nu). Android citește aceleași rânduri prin API (fără push nativ în această iterație).
 *
 * Migrația: `src/db/migrations/0028_notifications.sql` (DDL-ul de aici, generat de drizzle-kit,
 * plus partea scrisă de mână: RLS, drepturile, funcția `finet.notification_targets`).
 */

export const NOTIFICATION_KINDS = [
  "payment_due",
  "budget_warning",
  "budget_exceeded",
  "unusual_spending",
  "goal_reminder",
  "subscription_renewal",
  "monthly_summary",
  "sync_failure",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const notifications = finet.table(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: NOTIFICATION_KINDS }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    link: text("link"),
    dedupKey: text("dedup_key").notNull(),
    createdAt: createdAt(),
    readAt: ts("read_at"),
    emailedAt: ts("emailed_at"),
  },
  (t) => [
    unique("notifications_user_dedup_key").on(t.userId, t.dedupKey),
    index("notifications_user_created_idx").on(t.userId, t.createdAt),
    index("notifications_household_idx").on(t.householdId),
    check(
      "notifications_kind_valid",
      sql`${t.kind} in ('payment_due', 'budget_warning', 'budget_exceeded', 'unusual_spending', 'goal_reminder', 'subscription_renewal', 'monthly_summary', 'sync_failure')`,
    ),
    check("notifications_title_length", sql`char_length(${t.title}) between 1 and 200`),
    check("notifications_body_length", sql`char_length(${t.body}) between 1 and 2000`),
    check(
      "notifications_link_shape",
      sql`${t.link} is null or ${t.link} ~ '^/[a-z0-9/?=&._-]{0,200}$'`,
    ),
    check("notifications_dedup_key_length", sql`char_length(${t.dedupKey}) between 1 and 200`),
  ],
);

export const notificationPreferences = finet.table(
  "notification_preferences",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    inApp: boolean("in_app").notNull().default(true),
    email: boolean("email").notNull().default(false),
    // Tipurile active; un tip absent nu se generează deloc (nici în aplicație, nici pe email).
    kinds: text("kinds")
      .array()
      .notNull()
      .default(
        sql`array['payment_due', 'budget_warning', 'budget_exceeded', 'unusual_spending', 'goal_reminder', 'subscription_renewal', 'monthly_summary', 'sync_failure']::text[]`,
      ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "notification_preferences_kinds_valid",
      sql`${t.kinds} <@ array['payment_due', 'budget_warning', 'budget_exceeded', 'unusual_spending', 'goal_reminder', 'subscription_renewal', 'monthly_summary', 'sync_failure']::text[]`,
    ),
    check("notification_preferences_kinds_count", sql`cardinality(${t.kinds}) <= 8`),
  ],
);
