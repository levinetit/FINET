import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import type { DbOrTx } from "@/db";
import { accounts } from "@/db/schema";
import { type Actor, withMember } from "@/lib/authz";
import { type LiveEventType, publishLive } from "@/modules/live/live-bus";

/**
 * Publicarea evenimentelor live din handlere (Faza 8, ADR 0017), DUPĂ ce mutația s-a încheiat
 * (tranzacția comisă): clientul care reîncarcă imediat vede deja datele noi.
 *
 * Publicul: o tranzacție sau un transfer care atinge DOAR conturi personale ale actorului ajunge
 * doar la el; dacă atinge un cont comun, la toată gospodăria. Împărțirile, decontările, membrii și
 * bonurile sunt vizibile tuturor membrilor (ADR 0016), deci ajung la toată gospodăria.
 */

export type Audience = Readonly<{ onlyUserId?: string }>;

const HOUSEHOLD: Audience = Object.freeze({});

/**
 * Publicul pentru conturile atinse (citite sub RLS-ul actorului). Fail closed: la orice eroare,
 * sau dacă niciun cont nu e vizibil, doar actorul.
 */
export async function accountsAudience(
  db: DbOrTx,
  actor: Actor,
  householdId: string,
  accountIds: readonly string[],
): Promise<Audience> {
  const only: Audience = { onlyUserId: actor.userId };
  const ids = [...new Set(accountIds.map((id) => id.toLowerCase()))];
  if (ids.length === 0) return only;
  try {
    const rows = await withMember(
      actor,
      householdId,
      "member",
      (tx, m) =>
        tx
          .select({ ownerUserId: accounts.ownerUserId })
          .from(accounts)
          .where(and(eq(accounts.householdId, m.householdId), inArray(accounts.id, ids))),
      { db },
    );
    return rows.some((r) => r.ownerUserId === null) ? HOUSEHOLD : only;
  } catch {
    return only;
  }
}

/** Gospodăria întreagă (împărțiri, decontări, membri, bonuri). */
export const householdAudience = (): Audience => HOUSEHOLD;

/** Publicul cel mai larg dintre două (de exemplu contul vechi și cel nou al unei tranzacții). */
export function widest(a: Audience, b: Audience): Audience {
  if (a.onlyUserId === undefined || b.onlyUserId === undefined) return HOUSEHOLD;
  return a.onlyUserId.toLowerCase() === b.onlyUserId.toLowerCase() ? a : HOUSEHOLD;
}

export function notifyLive(
  householdId: string,
  type: LiveEventType,
  id: string,
  audience: Audience,
): void {
  publishLive({ householdId, type, id, ...audience });
}
