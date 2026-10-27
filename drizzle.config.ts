import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit: DOAR `generate` (scrie migrații SQL în `src/db/migrations/`, fără conexiune la
 * bază). Nu folosi `drizzle-kit push`/`migrate`/`pull`: migrațiile se aplică numai prin
 * `src/db/migrate.ts` (rolul `migrate`), iar `push` ar ignora politicile RLS scrise de mână.
 *
 *   pnpm db:generate --name <nume>             # din schema TypeScript
 *   pnpm db:generate --custom --name <nume>    # migrație SQL scrisă de mână (RLS, drepturi)
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  schemaFilter: ["finet"],
  // Același tabel de evidență ca runner-ul (`src/db/migrate.ts`), în schema `finet`.
  migrations: { schema: "finet", table: "__drizzle_migrations" },
  strict: true,
  verbose: true,
});
