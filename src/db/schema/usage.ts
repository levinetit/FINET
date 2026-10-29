import { sql } from "drizzle-orm";
import { bigint, check, date, primaryKey, text } from "drizzle-orm/pg-core";

import { finet, updatedAt } from "./finet";

/**
 * Faza 9 (F9-B, ADR 0021) — retenția evenimentelor de utilizare (master prompt 6.5): după 13 luni,
 * rândurile din `app_events` se agregă AICI pe zi (locală, `Europe/Bucharest`), nume, platformă,
 * versiune, ecran și cod de eroare, apoi se șterg. Fără utilizator, instalare sau gospodărie:
 * agregatul e anonim. Câmpurile lipsă devin șirul gol (cheia primară nu acceptă NULL).
 *
 * Migrația: `src/db/migrations/0016_gdpr_stats.sql` (DDL-ul generat + partea scrisă de mână: RLS
 * ENABLE+FORCE, politicile proprietarului, funcțiile SECURITY DEFINER). Aplicația (`finet_app`) NU
 * are niciun drept direct pe tabel: scrie doar `finet.aggregate_app_events`, citește doar
 * `finet.usage_stats`. CHECK-uri plate (fără BETWEEN în lanț AND).
 */

export const AGGREGATE_PLATFORMS = ["android", "web", "unknown"] as const;

export const appEventDaily = finet.table(
  "app_event_daily",
  {
    day: date("day", { mode: "string" }).notNull(),
    name: text("name").notNull(),
    platform: text("platform", { enum: AGGREGATE_PLATFORMS }).notNull(),
    appVersion: text("app_version").notNull().default(""),
    screen: text("screen").notNull().default(""),
    errorCode: text("error_code").notNull().default(""),
    count: bigint("count", { mode: "number" }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: "app_event_daily_pkey",
      columns: [t.day, t.name, t.platform, t.appVersion, t.screen, t.errorCode],
    }),
    check("app_event_daily_name_format", sql`${t.name} ~ '^[a-z][a-z0-9_.]{1,63}$'`),
    check("app_event_daily_platform_valid", sql`${t.platform} in ('android', 'web', 'unknown')`),
    check("app_event_daily_app_version_format", sql`${t.appVersion} ~ '^[0-9A-Za-z.+_-]{0,32}$'`),
    check("app_event_daily_screen_format", sql`${t.screen} ~ '^([a-z][a-z0-9_.]{0,63})?$'`),
    check("app_event_daily_error_code_format", sql`${t.errorCode} ~ '^([a-z][a-z0-9_.]{0,63})?$'`),
    check("app_event_daily_count_min", sql`${t.count} >= 1`),
    check("app_event_daily_day_min", sql`${t.day} >= date '2020-01-01'`),
    check("app_event_daily_day_max", sql`${t.day} <= date '2999-12-31'`),
  ],
);
