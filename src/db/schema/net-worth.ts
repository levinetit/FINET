import { sql } from "drizzle-orm";
import { bigint, check, date, foreignKey, index, text, unique, uuid } from "drizzle-orm/pg-core";

import { users } from "./auth";
import { createdAt, finet } from "./finet";
import { DB_CURRENCIES, households } from "./households";
import { accounts } from "./ledger";

/**
 * Modernizare 2026 — averea netă (ADR 0046). Evaluările conturilor fără tranzacții (investiții,
 * proprietăți, vehicule, credite): valoarea contului la o dată, semnată ca un sold (activele
 * pozitive, pasivele negative). Valoarea curentă a contului = evaluarea cea mai recentă; averea
 * netă la sfârșitul unei luni = evaluarea cea mai recentă de până atunci. Istoricul nu are
 * instantanee: se recalculează din tranzacții și evaluări (vizibilitatea urmează RLS-ul).
 *
 * Migrația: `src/db/migrations/0027_net_worth.sql` (DDL-ul de aici, generat de drizzle-kit, plus
 * partea scrisă de mână: CHECK-ul tipurilor de cont rescris, RLS, drepturile).
 */

const minor = (name: string) => bigint(name, { mode: "bigint" });

export const accountValuations = finet.table(
  "account_valuations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull(),
    currency: text("currency", { enum: DB_CURRENCIES }).notNull(),
    valuedOn: date("valued_on", { mode: "string" }).notNull(),
    valueMinor: minor("value_minor").notNull(),
    note: text("note"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    // Contul din aceeași gospodărie și aceeași monedă (cheia compusă a conturilor).
    foreignKey({
      name: "account_valuations_account_fk",
      columns: [t.accountId, t.householdId, t.currency],
      foreignColumns: [accounts.id, accounts.householdId, accounts.currency],
    }).onDelete("cascade"),
    unique("account_valuations_account_day_key").on(t.accountId, t.valuedOn),
    index("account_valuations_household_idx").on(t.householdId, t.valuedOn),
    check(
      "account_valuations_value_range",
      sql`${t.valueMinor} between -10000000000000 and 10000000000000`,
    ),
    check(
      "account_valuations_valued_on_range",
      sql`${t.valuedOn} between '1900-01-01' and '2999-12-31'`,
    ),
    check(
      "account_valuations_note_length",
      sql`${t.note} is null or char_length(${t.note}) <= 200`,
    ),
    check("account_valuations_currency_valid", sql`${t.currency} in ('RON', 'EUR', 'USD')`),
  ],
);
