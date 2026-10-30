import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./auth";
import { createdAt, finet, updatedAt } from "./finet";

/**
 * Faza 11-B (ADR 0028): feedback și rapoarte de bug-uri din aplicație, anunțuri de la administrator
 * și monitorizarea internă a erorilor. NICIUNA nu conține date financiare: feedback-ul e text liber
 * plafonat (cu o notă în interfață să nu se scrie date personale), anunțurile sunt scrise de
 * administrator, iar erorile păstrează doar tipul, ruta, un cod și un digest (fără mesaje, fără
 * stive, fără date ale utilizatorului).
 *
 * Migrația: `src/db/migrations/0020_admin_feedback.sql` (DDL-ul de aici, generat de drizzle-kit,
 * plus partea scrisă de mână: funcțiile administratorului, RLS ENABLE + FORCE cu politici pe
 * comandă și drepturile minime). CHECK-uri PLATE (lecția Fazelor 3–10).
 */

export const FEEDBACK_KINDS = ["feedback", "bug"] as const;
export const FEEDBACK_STATUSES = ["new", "seen", "closed"] as const;
export const ANNOUNCEMENT_LEVELS = ["info", "warn"] as const;
export const APP_ERROR_KINDS = ["client", "server"] as const;

export const FEEDBACK_MESSAGE_MAX = 2000;
export const ANNOUNCEMENT_TITLE_MAX = 100;
export const ANNOUNCEMENT_BODY_MAX = 500;

export const feedback = finet.table(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Autorul; la ștergerea contului dispare și feedback-ul lui (date personale în text liber). */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: FEEDBACK_KINDS }).notNull(),
    message: text("message").notNull(),
    /** Ruta paginii (fără parametri), ca să se știe unde a apărut; nu conținutul ei. */
    page: text("page"),
    appVersion: text("app_version"),
    status: text("status", { enum: FEEDBACK_STATUSES }).notNull().default("new"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("feedback_status_created_idx").on(t.status, t.createdAt),
    index("feedback_user_id_idx").on(t.userId),
    check("feedback_kind_valid", sql`${t.kind} in ('feedback', 'bug')`),
    check("feedback_status_valid", sql`${t.status} in ('new', 'seen', 'closed')`),
    check(
      "feedback_message_length",
      sql`char_length(${t.message}) >= 3 and char_length(${t.message}) <= 2000`,
    ),
    check(
      "feedback_page_shape",
      sql`${t.page} is null or (char_length(${t.page}) <= 200 and ${t.page} ~ '^/[A-Za-z0-9/_\\[\\]-]*$')`,
    ),
    check(
      "feedback_app_version_length",
      sql`${t.appVersion} is null or char_length(${t.appVersion}) <= 40`,
    ),
  ],
);

export const announcements = finet.table(
  "announcements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    level: text("level", { enum: ANNOUNCEMENT_LEVELS }).notNull().default("info"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    archived: boolean("archived").notNull().default(false),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    index("announcements_active_idx").on(t.archived, t.startsAt),
    index("announcements_created_by_user_id_idx").on(t.createdByUserId),
    check("announcements_level_valid", sql`${t.level} in ('info', 'warn')`),
    check(
      "announcements_title_length",
      sql`char_length(${t.title}) >= 1 and char_length(${t.title}) <= 100 and ${t.title} = btrim(${t.title})`,
    ),
    check(
      "announcements_body_length",
      sql`char_length(${t.body}) >= 1 and char_length(${t.body}) <= 500`,
    ),
    check("announcements_period", sql`${t.endsAt} is null or ${t.endsAt} > ${t.startsAt}`),
  ],
);

export const appErrors = finet.table(
  "app_errors",
  {
    /** Amprenta (`kind:rută:cod:digest`, scurtată): o singură linie per eroare distinctă. */
    fingerprint: text("fingerprint").primaryKey(),
    kind: text("kind", { enum: APP_ERROR_KINDS }).notNull(),
    route: text("route").notNull(),
    code: text("code").notNull(),
    digest: text("digest"),
    appVersion: text("app_version"),
    occurrences: bigint("occurrences", { mode: "number" }).notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** Câte rânduri a avut în ultima oră (limitare); nu se afișează. */
    recentBurst: integer("recent_burst").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("app_errors_last_seen_idx").on(t.lastSeenAt),
    check("app_errors_kind_valid", sql`${t.kind} in ('client', 'server')`),
    check("app_errors_fingerprint_length", sql`char_length(${t.fingerprint}) <= 200`),
    check(
      "app_errors_route_shape",
      sql`char_length(${t.route}) <= 200 and ${t.route} ~ '^/[A-Za-z0-9/_\\[\\]-]*$'`,
    ),
    check("app_errors_code_shape", sql`${t.code} ~ '^[A-Za-z0-9_.:-]{1,60}$'`),
    check(
      "app_errors_digest_shape",
      sql`${t.digest} is null or ${t.digest} ~ '^[A-Za-z0-9_-]{1,40}$'`,
    ),
    check(
      "app_errors_app_version_length",
      sql`${t.appVersion} is null or char_length(${t.appVersion}) <= 40`,
    ),
    check("app_errors_occurrences_positive", sql`${t.occurrences} >= 1`),
  ],
);
