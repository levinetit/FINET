import { pgSchema, timestamp } from "drizzle-orm/pg-core";

/**
 * Schema Postgres `finet` (master prompt 3.5): toate tabelele FINET stau aici, nu în `public`.
 * Schema o creează operatorul (`ops/supabase/roles.sql`), deținută de `finet_migrator`; de aceea
 * migrațiile NU conțin `CREATE SCHEMA` (vezi `src/db/migrations/0000_core.sql`).
 */
export const finet = pgSchema("finet");

/** `created_at`: momentul creării, `timestamptz` (UTC), completat de bază. */
export const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

/**
 * `updated_at`: completat de bază la inserare și de Drizzle la fiecare `update()` (`$onUpdate`).
 * Un UPDATE scris de mână trebuie să-l seteze explicit (nu există trigger).
 */
export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
