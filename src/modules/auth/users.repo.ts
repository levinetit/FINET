import "server-only";

import { and, eq, sql } from "drizzle-orm";

import type { Db, Tx } from "@/db";
import { authAccounts, authSessions, userPreferences, users } from "@/db/schema";

/**
 * Accesul la tabelele de autentificare (`users`, `auth_*`, fără RLS) și la preferințe (RLS pe
 * utilizatorul curent). Doar serverul și CLI-ul de administrare le folosesc, ca `finet_app`.
 */

/** Furnizorul Better Auth pentru email + parolă; `account_id` = id-ul utilizatorului. */
export const CREDENTIAL_PROVIDER = "credential";

export type UserRow = typeof users.$inferSelect;

type Executor = Db | Tx;

export async function findUserByEmail(db: Executor, email: string): Promise<UserRow | null> {
  const rows = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  return rows[0] ?? null;
}

export async function findUserById(db: Executor, id: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Serializează creările de utilizatori (regula „primul utilizator devine administrator”). */
export async function lockUserCreation(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('finet.create_user'))`);
}

export type NewUserRow = Readonly<{
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}>;

/**
 * INSERT cu listă explicită de coloane (M5): `finet_app` are INSERT doar pe coloanele de mai
 * jos, iar `tx.insert(users)` din Drizzle ar enumera toate coloanele (cu `default`).
 * `status` și `is_platform_admin` iau valorile implicite.
 */
export async function insertUser(tx: Tx, row: NewUserRow): Promise<void> {
  await tx.execute(sql`
    insert into finet.users (id, email, name, email_verified)
    values (${row.id}, ${row.email}, ${row.name}, ${row.emailVerified})`);
}

/** Promovează utilizatorul din context ca prim administrator (dacă nu există niciunul). */
export async function promoteFirstAdmin(tx: Tx, userId: string): Promise<boolean> {
  const rows = await tx.execute<{ promoted: boolean }>(
    sql`select finet.promote_first_admin(${userId}::uuid) as promoted`,
  );
  return rows[0]?.promoted === true;
}

export async function insertCredentialAccount(
  tx: Tx,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await tx.insert(authAccounts).values({
    userId,
    providerId: CREDENTIAL_PROVIDER,
    accountId: userId,
    password: passwordHash,
  });
}

/** Hash-ul parolei curente (`null` dacă utilizatorul nu are cont cu parolă). */
export async function findPasswordHash(db: Executor, userId: string): Promise<string | null> {
  const rows = await db
    .select({ password: authAccounts.password })
    .from(authAccounts)
    .where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, CREDENTIAL_PROVIDER)))
    .limit(1);
  return rows[0]?.password ?? null;
}

/** Setează parola (creează contul cu parolă dacă lipsește). */
export async function setPasswordHash(tx: Tx, userId: string, passwordHash: string): Promise<void> {
  const updated = await tx
    .update(authAccounts)
    .set({ password: passwordHash })
    .where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, CREDENTIAL_PROVIDER)))
    .returning({ id: authAccounts.id });
  if (updated.length === 0) await insertCredentialAccount(tx, userId, passwordHash);
}

/** Preferințele implicite (master prompt 5.2, 5.1): română, București, RON. */
export const DEFAULT_PREFERENCES = Object.freeze({
  locale: "ro-RO",
  timezone: "Europe/Bucharest",
  defaultCurrency: "RON",
} as const);

/** Inserează preferințele implicite (RLS: contextul trebuie să fie utilizatorul însuși). */
export async function insertDefaultPreferences(tx: Tx, userId: string): Promise<void> {
  await tx
    .insert(userPreferences)
    .values({ userId, ...DEFAULT_PREFERENCES })
    .onConflictDoNothing({ target: userPreferences.userId });
}

export async function deleteSessionsOfUser(
  tx: Executor,
  userId: string,
  exceptSessionId?: string,
): Promise<number> {
  const where = exceptSessionId
    ? and(eq(authSessions.userId, userId), sql`${authSessions.id} <> ${exceptSessionId}`)
    : eq(authSessions.userId, userId);
  const deleted = await tx.delete(authSessions).where(where).returning({ id: authSessions.id });
  return deleted.length;
}

export async function deleteUser(db: Executor, userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
}
