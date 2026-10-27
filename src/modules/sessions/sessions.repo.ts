import "server-only";

import { and, desc, eq, gt } from "drizzle-orm";

import type { Db } from "@/db";
import { authSessions } from "@/db/schema";

/**
 * Sesiunile utilizatorului (`finet.auth_sessions`, fără RLS): FIECARE query filtrează după
 * `user_id`-ul din sesiunea verificată, niciodată după un id venit din cerere singur.
 * Tokenul sesiunii nu se selectează niciodată.
 */

export type SessionRow = Readonly<{
  id: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}>;

export async function listActiveSessions(db: Db, userId: string, now: Date): Promise<SessionRow[]> {
  return db
    .select({
      id: authSessions.id,
      createdAt: authSessions.createdAt,
      updatedAt: authSessions.updatedAt,
      expiresAt: authSessions.expiresAt,
      ipAddress: authSessions.ipAddress,
      userAgent: authSessions.userAgent,
    })
    .from(authSessions)
    .where(and(eq(authSessions.userId, userId), gt(authSessions.expiresAt, now)))
    .orderBy(desc(authSessions.updatedAt));
}

/** Șterge o sesiune a utilizatorului; `false` dacă nu există sau e a altcuiva. */
export async function deleteSessionOfUser(
  db: Db,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(authSessions)
    .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId)))
    .returning({ id: authSessions.id });
  return deleted.length > 0;
}
