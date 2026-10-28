import "server-only";

import { asc, eq } from "drizzle-orm";

import { type DbOrTx, withRlsOn } from "@/db";
import { householdMembers, households, users } from "@/db/schema";
import { type Actor, type HouseholdRole, NotFoundError, withMember } from "@/lib/authz";
import { currentHouseholdIdOf } from "@/modules/auth/audit";
import { isValidId } from "@/modules/ledger/input";

/**
 * Gospodăriile utilizatorului curent (`GET /api/v1/households[/{id}]`). Lista vine din
 * apartenențele lui (RLS: le vede doar pe ale lui); detaliul cere apartenența (altfel 404).
 *
 * Decizia mea (ADR 0005): membrii apar doar cu id intern, nume, rol și data intrării, FĂRĂ
 * emailuri (nu sunt necesare clientului și ar expune date personale ale altora).
 */

export type HouseholdSummary = Readonly<{
  id: string;
  name: string;
  defaultCurrency: "RON" | "EUR" | "USD";
  timezone: string;
  role: HouseholdRole;
  /** Gospodăria în care lucrează API-ul (cea mai veche apartenență, ADR 0003). */
  current: boolean;
  joinedAt: string;
}>;

export type HouseholdMember = Readonly<{
  userId: string;
  name: string;
  role: HouseholdRole;
  joinedAt: string;
}>;

export type HouseholdDetail = HouseholdSummary & Readonly<{ members: HouseholdMember[] }>;

export async function listMyHouseholds(db: DbOrTx, actor: Actor): Promise<HouseholdSummary[]> {
  return withRlsOn(db, { userId: actor.userId }, async (tx) => {
    const current = await currentHouseholdIdOf(tx, actor.userId);
    const rows = await tx
      .select({
        id: households.id,
        name: households.name,
        defaultCurrency: households.defaultCurrency,
        timezone: households.timezone,
        role: householdMembers.role,
        joinedAt: householdMembers.joinedAt,
      })
      .from(householdMembers)
      .innerJoin(households, eq(households.id, householdMembers.householdId))
      .where(eq(householdMembers.userId, actor.userId))
      .orderBy(asc(householdMembers.joinedAt), asc(households.id));
    return rows.map((r) => ({
      ...r,
      current: r.id === current,
      joinedAt: r.joinedAt.toISOString(),
    }));
  });
}

export async function getMyHousehold(
  db: DbOrTx,
  actor: Actor,
  householdId: string,
): Promise<HouseholdDetail> {
  if (!isValidId(householdId)) throw new NotFoundError();
  const id = householdId.toLowerCase();
  const list = await listMyHouseholds(db, actor);
  const summary = list.find((h) => h.id === id);
  if (!summary) throw new NotFoundError();
  const members = await withMember(
    actor,
    id,
    "member",
    (tx) =>
      tx
        .select({
          userId: householdMembers.userId,
          name: users.name,
          role: householdMembers.role,
          joinedAt: householdMembers.joinedAt,
        })
        .from(householdMembers)
        .innerJoin(users, eq(users.id, householdMembers.userId))
        .where(eq(householdMembers.householdId, id))
        .orderBy(asc(householdMembers.joinedAt), asc(householdMembers.userId)),
    { db },
  );
  return {
    ...summary,
    members: members.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() })),
  };
}
