import { sql } from "drizzle-orm";
import { check, index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { users } from "./auth";
import { createdAt, finet, updatedAt } from "./finet";
import { DB_CURRENCIES, households } from "./households";

/** Preferințe, consimțăminte și jurnalul de audit (master prompt 6.1, 6.3). */

export const THEMES = ["system", "light", "dark"] as const;
export const CONSENT_KINDS = ["external_ai", "external_ai_statements", "usage_stats"] as const;

export const userPreferences = finet.table(
  "user_preferences",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    locale: text("locale").notNull().default("ro-RO"),
    timezone: text("timezone").notNull().default("Europe/Bucharest"),
    defaultCurrency: text("default_currency", { enum: DB_CURRENCIES }).notNull().default("RON"),
    theme: text("theme", { enum: THEMES }).notNull().default("system"),
    onboardingCompletedAt: timestamp("onboarding_completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("user_preferences_locale_format", sql`${t.locale} ~ '^[a-z]{2}-[A-Z]{2}$'`),
    check("user_preferences_timezone_length", sql`char_length(${t.timezone}) between 1 and 64`),
    check("user_preferences_currency_valid", sql`${t.defaultCurrency} in ('RON', 'EUR', 'USD')`),
    check("user_preferences_theme_valid", sql`${t.theme} in ('system', 'light', 'dark')`),
  ],
);

export const consents = finet.table(
  "consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: CONSENT_KINDS }).notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    // Cel mult un consimțământ activ (nerevocat) pe tip; istoricul revocărilor rămâne.
    uniqueIndex("consents_user_kind_active_key")
      .on(t.userId, t.kind)
      .where(sql`${t.revokedAt} is null`),
    check(
      "consents_kind_valid",
      sql`${t.kind} in ('external_ai', 'external_ai_statements', 'usage_stats')`,
    ),
    check(
      "consents_revoked_after_granted",
      sql`${t.revokedAt} is null or ${t.revokedAt} >= ${t.grantedAt}`,
    ),
  ],
);

/**
 * Jurnalul de audit: CINE a făcut CE, pe ce TIP de obiect. Fără sume, descrieri sau date
 * personale (6.1): `metadata` e un obiect JSON mic (max. 2 KB), cu chei tehnice. Doar adăugare
 * (rolul aplicației nu are UPDATE/DELETE, vezi `0001_rls.sql`).
 */
export const auditEvents = finet.table(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: uuid("target_id"),
    metadata: jsonb("metadata")
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_events_household_created_idx").on(t.householdId, t.createdAt.desc()),
    check("audit_events_action_format", sql`${t.action} ~ '^[a-z][a-z0-9_.]{1,63}$'`),
    check(
      "audit_events_target_type_format",
      sql`${t.targetType} is null or ${t.targetType} ~ '^[a-z][a-z0-9_]{1,63}$'`,
    ),
    check(
      "audit_events_metadata_small_object",
      sql`jsonb_typeof(${t.metadata}) = 'object' and pg_column_size(${t.metadata}) <= 2048`,
    ),
  ],
);
