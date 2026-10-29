import "server-only";

import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { type Db, type Tx, withRlsOn } from "@/db";
import {
  accounts,
  appEvents,
  authAccounts,
  authSessions,
  clientInstallations,
  consents,
  documents,
  householdMembers,
  households,
  statementUploads,
  userPreferences,
  users,
} from "@/db/schema";
import type { Storage } from "@/lib/storage";
import { isKeyOfHousehold } from "@/lib/storage";
import { insertAudit } from "@/modules/auth/audit";
import { verifyPassword } from "@/modules/auth/password";
import { findPasswordHash } from "@/modules/auth/users.repo";
import { lockHouseholdMembers, revokeInvitesCreatedBy } from "@/modules/family/family.repo";
import { loadHouseholdBalances } from "@/modules/family/settlements.service";
import { isSettled } from "@/modules/family/split-math";

import type {
  DeleteAccountInput,
  DeletionHousehold,
  DeletionPreview,
  DeletionResult,
} from "./gdpr.schema";

/**
 * Ștergerea contului (master prompt 5.6, 6.3 „GDPR”; ADR 0021).
 *
 * Reguli (decizia mea, ADR 0021):
 * - reautentificare: parola curentă (conturile cu parolă) sau, pentru conturile doar cu magic
 *   link, o sesiune creată în ultimele `FRESH_SESSION_MINUTES` minute; plus confirmarea scrisă
 *   „ȘTERGE” (verificată de schema Zod). Fără fereastră de grație: ștergerea e imediată și
 *   ireversibilă (datele nu stau „pe jumătate șterse”; exportul e oferit înainte, în UI);
 * - gospodăria în care e SINGURUL membru se șterge cu tot ce conține (cascada din bază), iar
 *   fișierele documentelor ei se șterg din storage DUPĂ commit;
 * - din gospodăriile cu alți membri iese (ca la „Părăsește gospodăria”, ADR 0016): invitațiile
 *   create de el se revocă, plecarea se auditează fără conținut; dacă e ULTIMUL owner, ștergerea
 *   e refuzată (409 `last_owner`) până transferă rolul (aceeași regulă L3; triggerul din bază o
 *   impune oricum); soldurile nedecontate NU blochează (rămân în istoricul celorlalți);
 * - pasul final `finet.erase_current_user()` (SECURITY DEFINER, 0016): conturile lui PERSONALE din
 *   TOATE gospodăriile (inclusiv cele părăsite demult) se șterg cu tranzacțiile lor (jumătatea
 *   comună a unui transfer devine o tranzacție obișnuită, soldul contului comun rămâne), bugetele
 *   personale se șterg, iar rândul `users` se șterge sau, dacă e referit de împărțiri/decontări
 *   din istoricul altora, se anonimizează („Cont șters”). Conturile personale NU devin comune;
 * - sesiunile, conturile de autentificare (hash-ul parolei), preferințele, instalările și
 *   evenimentele de utilizare se șterg; consimțămintele se revocă (și dispar odată cu rândul);
 * - administratorul platformei NU își poate șterge contul din aplicație (409 `platform_admin`):
 *   bootstrap-ul e irepetabil (M5), deci platforma ar rămâne fără administrator; garda e și în bază;
 * - totul într-O tranzacție (o eroare nu lasă nimic șters pe jumătate); idempotent: după succes
 *   sesiunea nu mai există (401), iar funcția din bază întoarce `not_found`.
 */

export const FRESH_SESSION_MINUTES = 15;

export class AccountDeletionError extends Error {
  constructor(
    readonly code:
      "invalid_password" | "reauth_required" | "last_owner" | "platform_admin" | "not_deletable",
    message: string,
  ) {
    super(message);
    this.name = "AccountDeletionError";
  }
}

export const WRONG_PASSWORD = "Parola nu e corectă.";

export type DeletionDeps = Readonly<{
  db: Db;
  storage: Storage;
  now?: () => Date;
}>;

type Session = Readonly<{ userId: string; sessionId: string }>;

type HouseholdState = DeletionHousehold &
  Readonly<{ role: "owner" | "member"; members: number; owners: number; unsettled: boolean }>;

async function myMemberships(tx: Tx, userId: string) {
  return tx
    .select({ id: householdMembers.householdId, role: householdMembers.role })
    .from(householdMembers)
    .where(eq(householdMembers.userId, userId))
    .orderBy(asc(householdMembers.joinedAt), asc(householdMembers.householdId));
}

/** Starea gospodăriei, citită în contextul ei (RLS: membrii gospodăriei curente). */
async function householdState(
  tx: Tx,
  userId: string,
  id: string,
  role: "owner" | "member",
): Promise<HouseholdState> {
  const [h] = await tx
    .select({ name: households.name })
    .from(households)
    .where(eq(households.id, id));
  const members = await tx
    .select({ userId: householdMembers.userId, role: householdMembers.role })
    .from(householdMembers)
    .where(eq(householdMembers.householdId, id));
  const owners = members.filter((m) => m.role === "owner").length;
  const unsettled = members.length > 1 && !isSettled(await loadHouseholdBalances(tx, id), userId);
  return { id, name: h?.name ?? "", role, members: members.length, owners, unsettled };
}

function blocks(s: HouseholdState): boolean {
  return s.members > 1 && s.role === "owner" && s.owners <= 1;
}

/** Ce s-ar întâmpla la ștergere (fără să modifice nimic). */
export async function previewAccountDeletion(db: Db, userId: string): Promise<DeletionPreview> {
  const hasPassword = (await findPasswordHash(db, userId)) !== null;
  const platformAdmin = await isAdmin(db, userId);
  const memberships = await withRlsOn(db, { userId }, (tx) => myMemberships(tx, userId));
  const states: HouseholdState[] = [];
  for (const m of memberships) {
    states.push(
      await withRlsOn(db, { userId, householdId: m.id }, (tx) =>
        householdState(tx, userId, m.id, m.role),
      ),
    );
  }
  return {
    hasPassword,
    platformAdmin,
    deletedHouseholds: states.filter((s) => s.members <= 1).map(({ id, name }) => ({ id, name })),
    leftHouseholds: states
      .filter((s) => s.members > 1 && !blocks(s))
      .map(({ id, name, unsettled }) => ({ id, name, unsettled })),
    blockedHouseholds: states.filter(blocks).map(({ id, name }) => ({ id, name })),
  };
}

async function isAdmin(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ admin: users.isPlatformAdmin })
    .from(users)
    .where(eq(users.id, userId));
  return row?.admin === true;
}

export const PLATFORM_ADMIN_MESSAGE =
  "Ești administratorul platformei: contul tău nu se poate șterge din aplicație. Operatorul trebuie să desemneze întâi alt administrator.";

async function reauthenticate(
  db: Db,
  session: Session,
  input: DeleteAccountInput,
  now: Date,
): Promise<void> {
  const stored = await findPasswordHash(db, session.userId);
  if (stored !== null) {
    const ok = input.password ? await verifyPassword(stored, input.password) : false;
    if (!ok) throw new AccountDeletionError("invalid_password", WRONG_PASSWORD);
    return;
  }
  // Fără parolă (doar magic link): sesiunea curentă trebuie să fie proaspătă.
  const [row] = await db
    .select({ createdAt: authSessions.createdAt })
    .from(authSessions)
    .where(and(eq(authSessions.id, session.sessionId), eq(authSessions.userId, session.userId)));
  const fresh =
    row !== undefined && now.getTime() - row.createdAt.getTime() <= FRESH_SESSION_MINUTES * 60_000;
  if (!fresh) {
    throw new AccountDeletionError(
      "reauth_required",
      "Pentru siguranță, deconectează-te, autentifică-te din nou și reia ștergerea.",
    );
  }
}

/** Gospodăria în care e singurul membru: cheile fișierelor, apoi ștergerea (cascadă). */
async function deleteSoleHousehold(tx: Tx, id: string): Promise<string[]> {
  const keys = await tx
    .select({ key: documents.storageKey })
    .from(documents)
    .where(and(eq(documents.householdId, id), isNotNull(documents.storageKey)));
  // Faza 7: PDF-urile temporare ale încărcărilor de extras (rândurile dispar în cascadă).
  const uploads = await tx
    .select({ key: statementUploads.storageKey })
    .from(statementUploads)
    .where(and(eq(statementUploads.householdId, id), isNotNull(statementUploads.storageKey)));
  const deleted = await tx
    .delete(households)
    .where(eq(households.id, id))
    .returning({ id: households.id });
  if (deleted.length === 0) {
    throw new AccountDeletionError(
      "not_deletable",
      "O gospodărie nu poate fi ștearsă. Contactează administratorul.",
    );
  }
  return [...keys, ...uploads]
    .map((k) => k.key)
    .filter((k): k is string => k !== null && isKeyOfHousehold(k, id));
}

/**
 * Faza 7: PDF-urile temporare ale încărcărilor de extras de pe conturile PERSONALE ale
 * utilizatorului într-o gospodărie pe care o părăsește (`erase_current_user` șterge conturile, iar
 * rândurile încărcărilor dispar în cascadă): cheile se adună înainte, fișierele se șterg după commit.
 */
async function personalStatementUploadKeys(tx: Tx, userId: string, householdId: string) {
  const rows = await tx
    .select({ key: statementUploads.storageKey })
    .from(statementUploads)
    .innerJoin(accounts, eq(accounts.id, statementUploads.accountId))
    .where(
      and(
        eq(statementUploads.householdId, householdId),
        eq(accounts.ownerUserId, userId),
        isNotNull(statementUploads.storageKey),
      ),
    );
  return rows
    .map((r) => r.key)
    .filter((k): k is string => k !== null && isKeyOfHousehold(k, householdId));
}

async function leaveHousehold(tx: Tx, userId: string, s: HouseholdState): Promise<void> {
  if (s.role === "owner") await revokeInvitesCreatedBy(tx, s.id, userId);
  // Auditul ÎNAINTE de ieșire (RLS pe audit_events cere apartenența), fără conținut.
  await insertAudit(tx, userId, s.id, {
    action: "household.member_left",
    targetType: "user",
    targetId: userId,
    metadata: { accountDeleted: true, unsettled: s.unsettled },
  });
  await tx
    .delete(householdMembers)
    .where(and(eq(householdMembers.householdId, s.id), eq(householdMembers.userId, userId)));
}

/** Datele lui care nu țin de o gospodărie (contextul RLS al utilizatorului). */
async function deletePersonalRows(tx: Tx, userId: string): Promise<void> {
  await tx.delete(appEvents).where(eq(appEvents.userId, userId));
  await tx.delete(clientInstallations).where(eq(clientInstallations.userId, userId));
  await tx
    .update(consents)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(consents.userId, userId), isNull(consents.revokedAt)));
  await tx.delete(userPreferences).where(eq(userPreferences.userId, userId));
  await tx.delete(authSessions).where(eq(authSessions.userId, userId));
  await tx.delete(authAccounts).where(eq(authAccounts.userId, userId));
}

/**
 * Șterge contul utilizatorului sesiunii. Reautentificarea în afara tranzacției (Argon2 nu ține
 * conexiunea ocupată), apoi totul atomic; fișierele după commit (o eroare la fișiere nu readuce
 * datele: se raportează doar ca număr în log, fișierele rămase sunt orfane fără rând în bază).
 */
export async function deleteAccount(
  deps: DeletionDeps,
  session: Session,
  input: DeleteAccountInput,
): Promise<DeletionResult> {
  const now = deps.now ? deps.now() : new Date();
  await reauthenticate(deps.db, session, input, now);
  const userId = session.userId;
  if (await isAdmin(deps.db, userId)) {
    throw new AccountDeletionError("platform_admin", PLATFORM_ADMIN_MESSAGE);
  }

  const { result, keys } = await deps.db.transaction(async (outer) => {
    await outer.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`finet.erase_user:${userId}`}))`,
    );
    const memberships = await withRlsOn(outer, { userId }, (tx) => myMemberships(tx, userId));
    const fileKeys: string[] = [];
    let deletedHouseholds = 0;
    let leftHouseholds = 0;
    for (const m of memberships) {
      await withRlsOn(outer, { userId, householdId: m.id }, async (tx) => {
        await lockHouseholdMembers(tx, m.id);
        const s = await householdState(tx, userId, m.id, m.role);
        if (blocks(s)) {
          throw new AccountDeletionError(
            "last_owner",
            "Ești ultimul proprietar al unei gospodării cu alți membri: transferă întâi rolul de proprietar.",
          );
        }
        if (s.members <= 1) {
          fileKeys.push(...(await deleteSoleHousehold(tx, m.id)));
          deletedHouseholds += 1;
        } else {
          fileKeys.push(...(await personalStatementUploadKeys(tx, userId, m.id)));
          await leaveHousehold(tx, userId, s);
          leftHouseholds += 1;
        }
      });
    }
    const outcome = await withRlsOn(outer, { userId }, async (tx) => {
      await deletePersonalRows(tx, userId);
      const rows = await tx.execute<{ r: string }>(sql`select finet.erase_current_user() as r`);
      return rows[0]?.r;
    });
    if (outcome !== "deleted" && outcome !== "anonymized") {
      throw new AccountDeletionError("not_deletable", "Contul nu mai există.");
    }
    return {
      result: { outcome, deletedHouseholds, leftHouseholds } satisfies DeletionResult,
      keys: fileKeys,
    };
  });

  let failed = 0;
  for (const key of keys) {
    try {
      await deps.storage.delete(key as Parameters<Storage["delete"]>[0]);
    } catch {
      failed += 1;
    }
  }
  // Fără id-uri sau nume: doar contoare.
  console.info(
    `[gdpr] cont ${result.outcome === "deleted" ? "șters" : "anonimizat"}; gospodării șterse=${result.deletedHouseholds} părăsite=${result.leftHouseholds} fișiere=${keys.length} eșuate=${failed}`,
  );
  return result;
}
