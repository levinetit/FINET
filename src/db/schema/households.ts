import { sql } from "drizzle-orm";
import { check, index, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { users } from "./auth";
import { createdAt, finet, updatedAt } from "./finet";

/**
 * Gospodăriile și membrii lor (master prompt 6.1). Toate datele financiare din fazele următoare
 * aparțin unei gospodării. RLS: `src/db/migrations/0001_rls.sql`.
 */

/** Monedele permise (5.1); aceeași listă ca `CURRENCIES` din `src/lib/money.ts`. */
export const DB_CURRENCIES = ["RON", "EUR", "USD"] as const;
export const HOUSEHOLD_ROLES = ["member", "owner"] as const;

export const households = finet.table(
  "households",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    defaultCurrency: text("default_currency", { enum: DB_CURRENCIES }).notNull().default("RON"),
    timezone: text("timezone").notNull().default("Europe/Bucharest"),
    // Cine a creat-o; păstrată la ștergerea utilizatorului (SET NULL), ca gospodăria să rămână
    // celorlalți membri.
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("households_created_by_idx").on(t.createdBy),
    check("households_name_length", sql`char_length(${t.name}) between 1 and 100`),
    check("households_currency_valid", sql`${t.defaultCurrency} in ('RON', 'EUR', 'USD')`),
    check("households_timezone_length", sql`char_length(${t.timezone}) between 1 and 64`),
  ],
);

export const householdMembers = finet.table(
  "household_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: HOUSEHOLD_ROLES }).notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    unique("household_members_household_user_key").on(t.householdId, t.userId),
    index("household_members_user_id_idx").on(t.userId),
    check("household_members_role_valid", sql`${t.role} in ('owner', 'member')`),
  ],
);
