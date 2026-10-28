import { authAccounts, authRateLimits, authSessions, authVerifications, users } from "./auth";

/**
 * Schema Drizzle FINET (Fazele 1–2). Sursa pentru `drizzle-kit generate` (`drizzle.config.ts`).
 * Politicile RLS, funcțiile și drepturile nu sunt declarate aici, ci scrise de mână în
 * `src/db/migrations/0001_rls.sql` și în partea a doua a `0002_ledger.sql` (drizzle-kit nu exprimă
 * FORCE RLS, triggerele și funcțiile SQL).
 */
export * from "./auth";
export * from "./finet";
export * from "./households";
export * from "./ledger";
export * from "./user-data";

/**
 * Maparea modelelor Better Auth pe tabelele FINET, pentru adaptorul Drizzle (F1-B):
 * `drizzleAdapter(db, { provider: "pg", schema: authSchema })`.
 */
export const authSchema = {
  user: users,
  session: authSessions,
  account: authAccounts,
  verification: authVerifications,
  rateLimit: authRateLimits,
} as const;
