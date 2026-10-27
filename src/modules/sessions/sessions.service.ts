import "server-only";

import type { Db } from "@/db";
import { NotFoundError } from "@/lib/authz";
import { recordAudit } from "@/modules/auth/audit";
import { ANDROID_USER_AGENT_PREFIX, describeDevice, truncateIp } from "@/modules/auth/request";
import { deleteSessionsOfUser } from "@/modules/auth/users.repo";

import { deleteSessionOfUser, listActiveSessions } from "./sessions.repo";
import { type SessionView, sessionIdSchema } from "./sessions.schema";

/**
 * Lista și revocarea sesiunilor proprii (Faza 1). `userId` și `currentSessionId` vin DOAR din
 * sesiunea verificată (`requireSession`). Sesiunea altui utilizator dă același 404 ca una
 * inexistentă (nu dezvăluim existența ei).
 */

export type SessionActor = Readonly<{ userId: string; sessionId: string }>;

export async function listMySessions(
  db: Db,
  actor: SessionActor,
  now: Date = new Date(),
): Promise<SessionView[]> {
  const rows = await listActiveSessions(db, actor.userId, now);
  return rows.map((row) => ({
    id: row.id,
    device: describeDevice(row.userAgent),
    platform: row.userAgent?.startsWith(ANDROID_USER_AGENT_PREFIX) ? "android" : "web",
    ipAddress: truncateIp(row.ipAddress),
    createdAt: row.createdAt.toISOString(),
    lastActiveAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    current: row.id === actor.sessionId,
  }));
}

/** Revocă o sesiune proprie (inclusiv pe cea curentă, echivalentul unui logout). */
export async function revokeMySession(db: Db, actor: SessionActor, rawId: string): Promise<void> {
  const parsed = sessionIdSchema.safeParse(rawId);
  if (!parsed.success) throw new NotFoundError();
  const sessionId = parsed.data.toLowerCase();
  if (!(await deleteSessionOfUser(db, actor.userId, sessionId))) throw new NotFoundError();
  await recordAudit(db, actor.userId, {
    action: "auth.session_revoked",
    targetType: "session",
    targetId: sessionId,
    metadata: { current: sessionId === actor.sessionId },
  });
}

/** Revocă toate celelalte sesiuni proprii; întoarce câte au fost revocate. */
export async function revokeMyOtherSessions(db: Db, actor: SessionActor): Promise<number> {
  const revoked = await deleteSessionsOfUser(db, actor.userId, actor.sessionId);
  await recordAudit(db, actor.userId, {
    action: "auth.sessions_revoked_others",
    targetType: "session",
    targetId: actor.sessionId,
    metadata: { revoked },
  });
  return revoked;
}
