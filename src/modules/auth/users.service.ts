import "server-only";

import { randomUUID } from "node:crypto";

import { and, asc, eq, sql } from "drizzle-orm";

import { type Db, isUuid, withRlsOn } from "@/db";
import { createHousehold } from "@/db/households";
import { householdMembers, users } from "@/db/schema";

import { currentHouseholdIdOf, insertAudit } from "./audit";
import { hashPassword } from "./password";
import { normalizeEmail } from "./request";
import {
  deleteSessionsOfUser,
  findUserByEmail,
  insertCredentialAccount,
  insertDefaultPreferences,
  insertUser,
  lockUserCreation,
  promoteFirstAdmin,
  setPasswordHash,
} from "./users.repo";

/**
 * Crearea și administrarea utilizatorilor (CLI-ul `admin`; Better Auth nu creează utilizatori). Fără importuri
 * Next.js sau Better Auth: CLI-ul se împachetează fără ele.
 *
 * Regula „gospodăria personală automată” (Faza 1): utilizatorul, contul cu parolă, preferințele
 * implicite, gospodăria personală (`finet.create_household`, în contextul RLS al noului
 * utilizator) și evenimentul de audit se scriu în ACEEAȘI tranzacție; orice eroare le anulează
 * pe toate.
 */

/** Numele gospodăriei personale (decizia mea; se poate redenumi din UI în Faza 8). */
export const PERSONAL_HOUSEHOLD_NAME = "Gospodăria mea";

export class UserServiceError extends Error {
  constructor(
    readonly code: "invalid_input" | "not_found" | "no_owner" | "disabled",
    message: string,
  ) {
    super(message);
    this.name = "UserServiceError";
  }
}

export type CreateUserInput = Readonly<{
  email: string;
  name: string;
  /** Parola în clar (validată de apelant cu politica); `null` = fără parolă (doar magic link). */
  password: string | null;
  /** Primul administrator al platformei, dacă nu există încă unul (CLI). */
  firstUserBecomesAdmin: boolean;
  /**
   * Emailul confirmat: utilizatorii creați de operator din CLI sunt considerați verificați
   * (decizia mea; altfel primul login prin magic link ar șterge contul cu parolă, regula
   * Better Auth pentru conturile nedovedite).
   */
  emailVerified: boolean;
}>;

export type CreateUserResult = Readonly<{
  created: boolean;
  userId: string;
  householdId: string | null;
  isPlatformAdmin: boolean;
}>;

const NAME_MAX = 100;

function checkName(name: string): string {
  const clean = name.trim();
  if (clean.length < 1 || clean.length > NAME_MAX) {
    throw new UserServiceError("invalid_input", `Numele trebuie să aibă 1–${NAME_MAX} caractere.`);
  }
  return clean;
}

/**
 * Creează utilizatorul cu gospodăria personală, atomic. Idempotent pe email: dacă există deja,
 * nu modifică nimic și întoarce `created: false`.
 */
export async function createUserWithHousehold(
  db: Db,
  input: CreateUserInput,
): Promise<CreateUserResult> {
  const email = normalizeEmail(input.email);
  const name = checkName(input.name);
  // Hash-ul se calculează în afara tranzacției (nu ține conexiunea ocupată ~50 ms).
  const passwordHash = input.password === null ? null : await hashPassword(input.password);
  const userId = randomUUID();

  return withRlsOn(db, { userId }, async (tx) => {
    await lockUserCreation(tx);
    const existing = await findUserByEmail(tx, email);
    if (existing) {
      return {
        created: false,
        userId: existing.id,
        householdId: null,
        isPlatformAdmin: existing.isPlatformAdmin,
      };
    }
    await insertUser(tx, { id: userId, email, name, emailVerified: input.emailVerified });
    // M5: aplicația nu poate scrie `is_platform_admin`; promovarea trece prin funcția dedicată.
    const isPlatformAdmin = input.firstUserBecomesAdmin
      ? await promoteFirstAdmin(tx, userId)
      : false;
    if (passwordHash) await insertCredentialAccount(tx, userId, passwordHash);
    await insertDefaultPreferences(tx, userId);
    const householdId = await createHousehold(tx, { name: PERSONAL_HOUSEHOLD_NAME });
    await insertAudit(tx, userId, householdId, {
      action: "user.created",
      targetType: "user",
      targetId: userId,
      metadata: { platformAdmin: isPlatformAdmin },
    });
    return { created: true, userId, householdId, isPlatformAdmin };
  });
}

/** Resetarea parolei de către operator: parola nouă + revocarea TUTUROR sesiunilor. */
export async function resetPasswordByEmail(
  db: Db,
  rawEmail: string,
  newPassword: string,
): Promise<{ userId: string; revokedSessions: number }> {
  const email = normalizeEmail(rawEmail);
  const user = await findUserByEmail(db, email);
  if (!user) throw new UserServiceError("not_found", "Nu există niciun utilizator cu acest email.");
  const passwordHash = await hashPassword(newPassword);
  return withRlsOn(db, { userId: user.id }, async (tx) => {
    await setPasswordHash(tx, user.id, passwordHash);
    const revokedSessions = await deleteSessionsOfUser(tx, user.id);
    const householdId = await currentHouseholdIdOf(tx, user.id);
    if (householdId) {
      await insertAudit(tx, user.id, householdId, {
        action: "auth.password_reset",
        targetType: "user",
        targetId: user.id,
        metadata: { via: "cli", revokedSessions },
      });
    }
    return { userId: user.id, revokedSessions };
  });
}

export type AddMemberResult = Readonly<{ added: boolean; userId: string; ownerId: string }>;

/**
 * Adaugă un utilizator existent într-o gospodărie (CLI, până la invitațiile din Faza 8).
 *
 * RLS permite inserarea doar unui `owner` ACTUAL al gospodăriei, în contextul lui. CLI-ul nu are
 * un actor propriu, deci acționează în numele unui owner existent (decizia mea): caută, printre
 * utilizatorii activi (în ordinea creării), primul pentru care `finet.member_role` întoarce
 * `owner` în acea gospodărie. Nu există o funcție SECURITY DEFINER pentru asta (aplicația web ar
 * putea-o apela). Idempotent: un membru existent nu se modifică (`added: false`).
 */
export async function addMemberByEmail(
  db: Db,
  householdId: string,
  rawEmail: string,
  role: "member" | "owner",
): Promise<AddMemberResult> {
  if (!isUuid(householdId)) {
    throw new UserServiceError("invalid_input", "Id-ul gospodăriei nu e un uuid valid.");
  }
  const email = normalizeEmail(rawEmail);
  const target = await findUserByEmail(db, email);
  if (!target)
    throw new UserServiceError("not_found", "Nu există niciun utilizator cu acest email.");
  if (target.status !== "active") {
    throw new UserServiceError("disabled", "Utilizatorul e dezactivat.");
  }

  const ownerId = await findOwner(db, householdId);
  if (!ownerId) {
    // Gospodărie inexistentă sau fără owner: același mesaj (nu contează pentru operator).
    throw new UserServiceError("no_owner", "Gospodăria nu există sau nu are niciun proprietar.");
  }

  return withRlsOn(db, { userId: ownerId, householdId }, async (tx) => {
    const existing = await tx
      .select({ id: householdMembers.id })
      .from(householdMembers)
      .where(
        and(eq(householdMembers.householdId, householdId), eq(householdMembers.userId, target.id)),
      )
      .limit(1);
    if (existing.length > 0) return { added: false, userId: target.id, ownerId };
    const inserted = await tx
      .insert(householdMembers)
      .values({ householdId, userId: target.id, role })
      .returning({ id: householdMembers.id });
    await insertAudit(tx, ownerId, householdId, {
      action: "household.member_added",
      targetType: "household_member",
      targetId: inserted[0]!.id,
      metadata: { role, via: "cli" },
    });
    return { added: true, userId: target.id, ownerId };
  });
}

async function findOwner(db: Db, householdId: string): Promise<string | null> {
  const candidates = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.status, "active"))
    .orderBy(asc(users.createdAt), asc(users.id));
  for (const { id } of candidates) {
    const role = await withRlsOn(db, { userId: id }, async (tx) => {
      const rows = await tx.execute<{ role: string | null }>(
        sql`select finet.member_role(${householdId}::uuid) as role`,
      );
      return rows[0]?.role ?? null;
    });
    if (role === "owner") return id;
  }
  return null;
}
