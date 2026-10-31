import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { withRlsOn } from "@/db";
import { pgErrorInfo } from "@/db/pg-errors";
import { type Actor, type HouseholdRole, NotFoundError } from "@/lib/authz";
import { ConflictError } from "@/lib/errors";
import { insertAudit } from "@/modules/auth/audit";
import { hitRateLimit, rateLimitKey } from "@/modules/auth/rate-limit";
import { isValidId, parseInput } from "@/modules/ledger/input";

import { type AcceptDeps, type FamilyDeps, inFamily, nowOf } from "./context";
import {
  acceptInviteRow,
  countInvitesSince,
  insertInvite,
  inviteStatus,
  lockHouseholdInvites,
  revokeInviteRow,
  selectInvite,
  selectInvites,
  selectMembers,
  setActiveHouseholdRow,
} from "./family.repo";
import {
  type CreatedInvite,
  INVITES_PER_DAY,
  INVITE_DEFAULT_HOURS,
  INVITE_TOKEN_PATTERN,
  type InviteView,
  inviteAcceptSchema,
  inviteCreateSchema,
} from "./family.schema";

/**
 * Invitațiile în gospodărie (Faza 8, ADR 0016; `/join/[token]` vine în F8-B).
 *
 * - Tokenul: 32 de octeți din CSPRNG (`randomBytes`, 256 de biți), în base64url. În bază se
 *   stochează DOAR SHA-256 (hex); tokenul în clar se întoarce O SINGURĂ DATĂ, la creare.
 * - Comparația: căutarea în bază se face după hash-ul tokenului primit (indexul unic). Timpul de
 *   răspuns depinde doar de hash, nu de token, deci o comparație „caracter cu caracter” pe token
 *   nu există; cele două hash-uri nu se compară niciodată în cod.
 * - Expirabilă (implicit 72 h, cel mult 168 h), de unică folosință (consum atomic în
 *   `finet.accept_invite`), revocabilă; limită de rată pe acceptare (per utilizator) și o limită
 *   zilnică de creare per gospodărie (doar crescătoare: invitațiile nu se șterg).
 * - Fără enumerare: token inexistent, expirat, folosit, revocat sau malformat → ACELAȘI răspuns
 *   (`InviteUnavailableError`).
 * - Doar `owner` creează, listează și revocă invitații.
 */

/** Răspunsul uniform pentru orice invitație inutilizabilă (HTTP 404 în API). */
export class InviteUnavailableError extends Error {
  readonly code = "invite_unavailable";
  readonly status = 404;
  constructor() {
    super("Invitația nu mai este valabilă.");
    this.name = "InviteUnavailableError";
  }
}

/** Prea multe încercări de acceptare (HTTP 429 în API). */
export class InviteRateLimitedError extends Error {
  readonly code = "rate_limited";
  readonly status = 429;
  constructor(readonly retryAfterSeconds: number) {
    super("Prea multe încercări. Încearcă din nou mai târziu.");
    this.name = "InviteRateLimitedError";
  }
}

export const DEFAULT_ACCEPT_LIMIT = { max: 10, windowSeconds: 15 * 60 } as const;

/** SHA-256 hex al tokenului în clar (singura formă care ajunge în bază). */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Un token nou: 256 de biți din CSPRNG, base64url fără padding (43 de caractere). */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

function view(row: Omit<InviteView, "status">, now: Date): InviteView {
  return { ...row, status: inviteStatus(row, now) };
}

export async function createInvite(
  deps: FamilyDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown = {},
): Promise<CreatedInvite> {
  const input = parseInput(inviteCreateSchema, rawInput) ?? {};
  const role: HouseholdRole = input.role ?? "member";
  const hours = input.expiresInHours ?? INVITE_DEFAULT_HOURS;
  return inFamily(deps, actor, householdId, "owner", async (tx, m) => {
    const now = nowOf(deps);
    await lockHouseholdInvites(tx, m.householdId);
    // Plafonul planului (Faza 12-A): membrii de acum + invitațiile încă valabile.
    if (deps.entitlements) {
      const max = await deps.entitlements.limit(m.householdId, "household.maxMembers");
      const members = (await selectMembers(tx, m.householdId)).length;
      const pending = (await selectInvites(tx, m.householdId)).filter(
        (r) => inviteStatus(r, now) === "active",
      ).length;
      if (members + pending >= max) {
        throw new ConflictError("household_full", "Planul curent nu mai permite alți membri.");
      }
    }
    const since = new Date(now.getTime() - 24 * 3600 * 1000);
    if ((await countInvitesSince(tx, m.householdId, since)) >= INVITES_PER_DAY) {
      throw new ConflictError("invite_limit", "Ai creat prea multe invitații azi.");
    }
    const token = generateInviteToken();
    // `created_at` și `expires_at` le calculează baza (`now()` + ore), ca CHECK-ul
    // `expires_at <= created_at + 168 h` să nu depindă de diferența dintre ceasuri.
    const row = await insertInvite(tx, {
      householdId: m.householdId,
      tokenHash: hashInviteToken(token),
      role,
      createdByUserId: actor.userId,
      hours,
    });
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "household.invite_created",
      targetType: "household_invite",
      targetId: row.id,
      metadata: { role, hours },
    });
    return { invite: view(row, now), token };
  });
}

export async function listInvites(
  deps: FamilyDeps,
  actor: Actor,
  householdId: string,
): Promise<InviteView[]> {
  return inFamily(deps, actor, householdId, "owner", async (tx, m) => {
    const now = nowOf(deps);
    return (await selectInvites(tx, m.householdId)).map((r) => view(r, now));
  });
}

export async function revokeInvite(
  deps: FamilyDeps,
  actor: Actor,
  householdId: string,
  inviteId: string,
): Promise<InviteView> {
  if (!isValidId(inviteId)) throw new NotFoundError();
  const id = inviteId.toLowerCase();
  return inFamily(deps, actor, householdId, "owner", async (tx, m) => {
    const now = nowOf(deps);
    const current = await selectInvite(tx, m.householdId, id);
    if (!current) throw new NotFoundError();
    const row = await revokeInviteRow(tx, m.householdId, id, now);
    if (!row) throw new ConflictError("invite_not_active", "Invitația nu mai e activă.");
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "household.invite_revoked",
      targetType: "household_invite",
      targetId: id,
    });
    return view(row, now);
  });
}

export type AcceptResult = Readonly<{
  householdId: string;
  /** `false` dacă utilizatorul era deja membru (invitația nu a fost consumată). */
  joined: boolean;
}>;

/**
 * Acceptă invitația pentru utilizatorul curent. Limita de rată se consumă ÎNAINTE de orice
 * verificare (și pentru tokenurile greșite), în afara tranzacției, deci o încercare eșuată
 * contează. La succes, gospodăria devine cea ACTIVĂ a utilizatorului (decizia mea: cine intră
 * printr-un link vrea să vadă familia).
 */
export async function acceptInvite(
  deps: AcceptDeps,
  actor: Actor,
  rawInput: unknown,
): Promise<AcceptResult> {
  const now = nowOf(deps);
  const limit = await hitRateLimit(
    deps.db,
    rateLimitKey("invite_accept", null, actor.userId),
    deps.acceptLimit ?? DEFAULT_ACCEPT_LIMIT,
    now.getTime(),
  );
  if (!limit.allowed) throw new InviteRateLimitedError(limit.retryAfterSeconds);
  const parsed = inviteAcceptSchema.safeParse(rawInput);
  if (
    !parsed.success ||
    !INVITE_TOKEN_PATTERN.test(parsed.data.token) ||
    !isValidId(actor.userId)
  ) {
    throw new InviteUnavailableError();
  }
  const tokenHash = hashInviteToken(parsed.data.token);
  try {
    return await withRlsOn(deps.db, { userId: actor.userId }, async (tx) => {
      const result = await acceptInviteRow(tx, tokenHash);
      if (!result) throw new InviteUnavailableError();
      // Membru deja: nimic consumat, nimic auditat.
      if (result.joined) {
        await insertAudit(tx, actor.userId, result.householdId, {
          action: "household.invite_accepted",
          targetType: "household",
          targetId: result.householdId,
        });
      }
      await setActiveHouseholdRow(tx, actor.userId, result.householdId);
      // Plafonul planului gospodăriei țintă (Faza 12-A): depășirea anulează intrarea (rollback).
      // După setarea gospodăriei active, membrul vede lista completă (RLS).
      if (result.joined && deps.entitlements) {
        const max = await deps.entitlements.limit(result.householdId, "household.maxMembers");
        if ((await selectMembers(tx, result.householdId)).length > max) {
          throw new ConflictError("household_full", "Planul gospodăriei nu mai permite membri.");
        }
      }
      return result;
    });
  } catch (error) {
    if (error instanceof InviteUnavailableError) throw error;
    const info = pgErrorInfo(error);
    if (info?.code === "54000" && info.constraint === "household_members_cap") {
      throw new ConflictError("household_full", "Gospodăria are deja numărul maxim de membri.");
    }
    throw error;
  }
}
