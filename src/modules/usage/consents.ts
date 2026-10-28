import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { type DbOrTx, type Tx, withRlsOn } from "@/db";
import { CONSENT_KINDS, consents } from "@/db/schema";
import { currentHouseholdIdOf, insertAudit } from "@/modules/auth/audit";
import { parseInput } from "@/modules/ledger/input";

import { CONSENT_API_NAMES, consentsPutSchema } from "./usage.schema";

export { CONSENT_API_NAMES, consentsPutSchema } from "./usage.schema";

/**
 * Consimțămintele utilizatorului curent (6.5, 3.6): `GET/PUT /api/v1/me/consents`. Istoricul
 * rămâne (revocarea pune `revoked_at`, o nouă acordare adaugă un rând); cel mult unul activ pe
 * tip (index unic parțial). Fiecare schimbare se auditează (doar tipul, fără alte date).
 *
 * Decizia mea (ADR 0005): `usage_stats` e activ DOAR cu un rând activ în `consents`, în ambele
 * moduri; clientul (web sau Android) îl acordă explicit prin `PUT` (în `personal`, Android îl
 * pornește la prima pornire, după ecranul de informare).
 */

export type ConsentKind = (typeof CONSENT_KINDS)[number];

export type ConsentState = Readonly<{
  kind: keyof typeof CONSENT_API_NAMES;
  granted: boolean;
  grantedAt: string | null;
  revokedAt: string | null;
}>;

async function readStates(tx: Tx, userId: string): Promise<ConsentState[]> {
  // Ultimul rând pe tip (activ sau cel mai recent revocat).
  const rows = await tx
    .select({ kind: consents.kind, grantedAt: consents.grantedAt, revokedAt: consents.revokedAt })
    .from(consents)
    .where(eq(consents.userId, userId))
    .orderBy(sql`${consents.revokedAt} is null desc`, sql`${consents.grantedAt} desc`);
  const latest = new Map<ConsentKind, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.kind)) latest.set(r.kind, r);
  return (Object.keys(CONSENT_API_NAMES) as (keyof typeof CONSENT_API_NAMES)[]).map((name) => {
    const r = latest.get(CONSENT_API_NAMES[name]);
    return {
      kind: name,
      granted: r !== undefined && r.revokedAt === null,
      grantedAt: r?.grantedAt.toISOString() ?? null,
      revokedAt: r?.revokedAt?.toISOString() ?? null,
    };
  });
}

export function getConsents(db: DbOrTx, userId: string): Promise<ConsentState[]> {
  return withRlsOn(db, { userId }, (tx) => readStates(tx, userId));
}

export async function setConsents(
  db: DbOrTx,
  userId: string,
  rawInput: unknown,
): Promise<ConsentState[]> {
  const input = parseInput(consentsPutSchema, rawInput);
  return withRlsOn(db, { userId }, async (tx) => {
    const householdId = await currentHouseholdIdOf(tx, userId);
    for (const [name, value] of Object.entries(input) as [
      keyof typeof CONSENT_API_NAMES,
      boolean | undefined,
    ][]) {
      if (value === undefined) continue;
      const kind = CONSENT_API_NAMES[name];
      let changed: boolean;
      if (value) {
        const rows = await tx
          .insert(consents)
          .values({ userId, kind })
          .onConflictDoNothing()
          .returning({ id: consents.id });
        changed = rows.length > 0;
      } else {
        const rows = await tx
          .update(consents)
          .set({ revokedAt: sql`now()` })
          .where(
            and(eq(consents.userId, userId), eq(consents.kind, kind), isNull(consents.revokedAt)),
          )
          .returning({ id: consents.id });
        changed = rows.length > 0;
        if (kind === "usage_stats") await eraseUsageData(tx, userId);
      }
      if (changed && householdId) {
        await insertAudit(tx, userId, householdId, {
          action: value ? "consent.granted" : "consent.revoked",
          targetType: "user",
          targetId: userId,
          metadata: { kind },
        });
      }
    }
    return readStates(tx, userId);
  });
}

/**
 * Revocarea `usage_stats` (MEDIUM-1, ADR 0005) șterge instalările și evenimentele utilizatorului
 * (RLS: doar rândurile proprii). Se face la fiecare `usageStats: false`, deci și pentru date
 * rămase dintr-o versiune anterioară. Statisticile agregate (Faza 9) nu sunt afectate.
 */
export async function eraseUsageData(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`delete from finet.app_events where user_id = ${userId}`);
  await tx.execute(sql`delete from finet.client_installations where user_id = ${userId}`);
}

/** `true` dacă utilizatorul are un consimțământ ACTIV de tipul dat. */
export async function hasActiveConsent(
  tx: Tx,
  userId: string,
  kind: ConsentKind,
): Promise<boolean> {
  const rows = await tx
    .select({ id: consents.id })
    .from(consents)
    .where(and(eq(consents.userId, userId), eq(consents.kind, kind), isNull(consents.revokedAt)))
    .limit(1);
  return rows.length > 0;
}
