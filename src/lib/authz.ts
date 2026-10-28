import "server-only";

import { and, eq } from "drizzle-orm";

import { type Db, type Tx, getDb, isUuid, withRlsOn } from "@/db";
import { HOUSEHOLD_ROLES, householdMembers } from "@/db/schema";

/**
 * Autorizarea în aplicație (master prompt 6.2, stratul 1). Orice acces la datele unei gospodării
 * trece prin `requireMember` sau `withMember`:
 * - `actor.userId` vine din sesiunea verificată (F1-B), niciodată din cerere;
 * - `householdId` vine din ruta validată; apartenența se verifică ÎN BAZĂ, nu din input;
 * - o gospodărie inexistentă, un id invalid sau una din care utilizatorul nu face parte dau
 *   ACELAȘI `NotFoundError` (nu dezvăluim existența resurselor altor gospodării → HTTP 404);
 * - un membru cu rol insuficient primește `ForbiddenError` (HTTP 403): el știe deja că
 *   gospodăria există.
 *
 * Verificarea rulează în contextul RLS al gospodăriei, deci e dublată de politicile din bază:
 * chiar și cu o greșeală aici, rândurile altei gospodării nu sunt vizibile.
 */

export type HouseholdRole = (typeof HOUSEHOLD_ROLES)[number];

/** Ierarhia rolurilor: `member` < `owner`. */
const ROLE_RANK: Readonly<Record<HouseholdRole, number>> = { member: 1, owner: 2 };

export function roleAtLeast(role: HouseholdRole, minRole: HouseholdRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

export type Actor = Readonly<{ userId: string }>;

export type Membership = Readonly<{
  householdId: string;
  userId: string;
  role: HouseholdRole;
}>;

/** Resursa nu există sau nu e accesibilă (fără a spune care dintre ele). */
export class NotFoundError extends Error {
  readonly code = "not_found";
  readonly status = 404;
  constructor() {
    super("Resursa nu a fost găsită.");
    this.name = "NotFoundError";
  }
}

/** Utilizatorul e membru, dar rolul lui nu permite operația. */
export class ForbiddenError extends Error {
  readonly code = "forbidden";
  readonly status = 403;
  constructor() {
    super("Nu ai dreptul să faci această operație.");
    this.name = "ForbiddenError";
  }
}

export type AuthzOptions = Readonly<{
  /** Clientul bazei (implicit `getDb()`); testele dau unul propriu. */
  db?: Db;
}>;

async function loadMembership(tx: Tx, actor: Actor, householdId: string): Promise<Membership> {
  const rows = await tx
    .select({ role: householdMembers.role })
    .from(householdMembers)
    .where(
      and(eq(householdMembers.householdId, householdId), eq(householdMembers.userId, actor.userId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError();
  return { householdId, userId: actor.userId, role: row.role };
}

function checkInputs(actor: Actor, householdId: string): void {
  // Un actor fără uuid valid e o greșeală de programare (sesiunea dă mereu un uuid), dar
  // răspunsul rămâne același: nimic nu e accesibil.
  if (!isUuid(actor.userId) || !isUuid(householdId)) throw new NotFoundError();
}

/**
 * Verifică apartenența utilizatorului la gospodărie, cu cel puțin rolul `minRole`, și întoarce
 * apartenența. Aruncă `NotFoundError` / `ForbiddenError`.
 */
export async function requireMember(
  actor: Actor,
  householdId: string,
  minRole: HouseholdRole = "member",
  options: AuthzOptions = {},
): Promise<Membership> {
  return withMember(actor, householdId, minRole, async (_tx, membership) => membership, options);
}

/**
 * Verifică apartenența și rulează `fn` în ACEEAȘI tranzacție, cu contextul RLS al gospodăriei
 * (`app.user_id`, `app.household_id`) deja setat. Forma recomandată pentru serviciile din
 * `src/modules/*`: verificarea și accesul la date nu pot fi separate din greșeală.
 */
export async function withMember<T>(
  actor: Actor,
  householdId: string,
  minRole: HouseholdRole,
  fn: (tx: Tx, membership: Membership) => Promise<T>,
  options: AuthzOptions = {},
): Promise<T> {
  checkInputs(actor, householdId);
  const db = options.db ?? getDb();
  return withRlsOn(db, { userId: actor.userId, householdId }, async (tx) => {
    const membership = await loadMembership(tx, actor, householdId.toLowerCase());
    if (!roleAtLeast(membership.role, minRole)) throw new ForbiddenError();
    return fn(tx, membership);
  });
}
