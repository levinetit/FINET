import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { users } from "./auth";
import { createdAt, finet, updatedAt } from "./finet";
import { households } from "./households";

/**
 * Faza 10 (F10-B) — definițiile rapoartelor de micro-cheltuieli; ADR 0023.
 *
 * Migrația: `src/db/migrations/0018_report_definitions.sql` (DDL-ul de aici, generat de
 * drizzle-kit într-o copie a repo-ului, plus partea scrisă de mână: rapoartele de sistem
 * (seed), triggerul plafonului, RLS ENABLE + FORCE cu politici pe comandă și drepturile minime).
 *
 * Un raport e o DEFINIȚIE ÎN DATE: reguli de potrivire pe `receipt_lines.normalized_name`
 * (`rules`, JSON versionat, validat strict de Zod în `src/modules/report-definitions`; baza
 * verifică doar forma și mărimea). `household_id` NULL = raport de SISTEM (`is_system`), citibil
 * de toți utilizatorii autentificați, schimbat doar printr-o migrație; altfel raportul aparține
 * unei gospodării (citit și scris de membrii ei).
 *
 * CHECK-uri PLATE (fără BETWEEN într-un lanț AND, fără operatori imbricați de același tip), ca
 * amprenta pg_dump să rămână stabilă (lecția Fazelor 3–9).
 */

export const REPORT_RULE_VERSION = 1;
/** Plafoanele (decizia mea, ADR 0023). */
export const REPORT_NAME_MAX = 80;
export const REPORT_TEXT_MAX = 500;
export const REPORT_RULES_MAX_BYTES = 8192;
export const REPORT_DEFINITIONS_PER_HOUSEHOLD_MAX = 100;

export const reportDefinitions = finet.table(
  "report_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** NULL pentru rapoartele de sistem. */
    householdId: uuid("household_id").references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** Regulile de potrivire (JSON versionat, `rules.ts`). */
    rules: jsonb("rules").$type<Readonly<Record<string, unknown>>>().notNull(),
    /** Sfat fix (text verificabil, fără sume de economie inventate). */
    advice: text("advice"),
    isSystem: boolean("is_system").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("report_definitions_household_archived_idx").on(t.householdId, t.archived),
    index("report_definitions_created_by_user_id_idx").on(t.createdByUserId),
    // Numele unic (fără diferență de litere) printre rapoartele active ale gospodăriei.
    uniqueIndex("report_definitions_household_name_active_key")
      .on(t.householdId, sql`lower(${t.name})`)
      .where(sql`not ${t.archived}`),
    // Numele rapoartelor de sistem sunt unice între ele.
    uniqueIndex("report_definitions_system_name_key")
      .on(sql`lower(${t.name})`)
      .where(sql`${t.isSystem}`),
    check(
      "report_definitions_name_length",
      sql`char_length(${t.name}) >= 1 and char_length(${t.name}) <= 80 and ${t.name} = btrim(${t.name})`,
    ),
    check(
      "report_definitions_description_length",
      sql`${t.description} is null or char_length(${t.description}) <= 500`,
    ),
    check(
      "report_definitions_advice_length",
      sql`${t.advice} is null or char_length(${t.advice}) <= 500`,
    ),
    check(
      "report_definitions_rules_shape",
      sql`jsonb_typeof(${t.rules}) = 'object' and pg_column_size(${t.rules}) <= 8192 and ${t.rules} ->> 'v' = '1'`,
    ),
    // Sistem ⇔ fără gospodărie; un raport de sistem nu are autor.
    check("report_definitions_scope_shape", sql`(${t.householdId} is null) = ${t.isSystem}`),
    check(
      "report_definitions_system_no_author",
      sql`not ${t.isSystem} or ${t.createdByUserId} is null`,
    ),
  ],
);
