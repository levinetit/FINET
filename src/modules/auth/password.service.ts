import "server-only";

import { type Db, withRlsOn } from "@/db";

import { currentHouseholdIdOf, insertAudit } from "./audit";
import type { ChangePasswordInput } from "./password.schema";
import {
  type PasswordPolicy,
  PASSWORD_PROBLEM_MESSAGES,
  checkPasswordPolicy,
  hashPassword,
  verifyPassword,
} from "./password";
import { deleteSessionsOfUser, findPasswordHash, setPasswordHash } from "./users.repo";

/**
 * Schimbarea parolei de către utilizator (6.3): cere parola curentă, aplică politica (minimum
 * 10 caractere, HIBP opțional), salvează hash-ul Argon2id nou și revocă TOATE celelalte sesiuni
 * (cea curentă rămâne). Totul într-o tranzacție, cu audit.
 */

export class PasswordChangeError extends Error {
  constructor(
    readonly code: "invalid_password" | "weak_password",
    message: string,
    readonly field: "currentPassword" | "newPassword",
  ) {
    super(message);
    this.name = "PasswordChangeError";
  }
}

/** Același mesaj pentru „parolă greșită” și „cont fără parolă” (nu dezvăluim diferența). */
export const WRONG_CURRENT_PASSWORD = "Parola curentă nu e corectă.";

export async function changePassword(
  db: Db,
  actor: Readonly<{ userId: string; sessionId: string }>,
  input: ChangePasswordInput,
  policy: PasswordPolicy,
): Promise<{ revokedSessions: number }> {
  const stored = await findPasswordHash(db, actor.userId);
  const ok = stored ? await verifyPassword(stored, input.currentPassword) : false;
  if (!ok)
    throw new PasswordChangeError("invalid_password", WRONG_CURRENT_PASSWORD, "currentPassword");

  const problem = await checkPasswordPolicy(input.newPassword, policy);
  if (problem) {
    throw new PasswordChangeError(
      "weak_password",
      PASSWORD_PROBLEM_MESSAGES[problem],
      "newPassword",
    );
  }
  const newHash = await hashPassword(input.newPassword);

  return withRlsOn(db, { userId: actor.userId }, async (tx) => {
    await setPasswordHash(tx, actor.userId, newHash);
    const revokedSessions = await deleteSessionsOfUser(tx, actor.userId, actor.sessionId);
    const householdId = await currentHouseholdIdOf(tx, actor.userId);
    if (householdId) {
      await insertAudit(tx, actor.userId, householdId, {
        action: "auth.password_changed",
        targetType: "user",
        targetId: actor.userId,
        metadata: { revokedSessions },
      });
    }
    return { revokedSessions };
  });
}
