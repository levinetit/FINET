import "server-only";

import type { Tx } from "@/db";
import { type Actor, ForbiddenError, NotFoundError, withMember } from "@/lib/authz";
import { ConflictError } from "@/lib/errors";
import { insertAudit } from "@/modules/auth/audit";
import { type HouseholdSummary, listMyHouseholds } from "@/modules/households/households.service";
import { translateDbError } from "@/modules/ledger/context";
import { isValidId, parseInput } from "@/modules/ledger/input";

import { type FamilyDeps, inFamily } from "./context";
import {
  clearActiveHouseholdIf,
  deleteMember,
  lockHouseholdMembers,
  selectMember,
  selectMembers,
  setActiveHouseholdRow,
  updateMemberRole,
} from "./family.repo";
import { type MemberView, activeHouseholdSchema, roleChangeSchema } from "./family.schema";
import { loadHouseholdBalances } from "./settlements.service";
import { isSettled } from "./split-math";

/**
 * Membrii gospodăriei și gospodăria activă (Faza 8, ADR 0016).
 *
 * Permisiuni (rolurile rămân `owner` / `member`, decizia mea: minimul necesar):
 * - listarea membrilor: orice membru;
 * - schimbarea rolului, eliminarea unui membru, transferul de ownership: doar `owner`;
 * - plecarea: oricine, pentru sine.
 * Protecția ULTIMULUI owner (L3): nu poate pleca, nu poate fi scos și nu poate fi retrogradat cât
 * timp ar lăsa gospodăria fără owner — verificată aici (mesaj clar) ȘI de triggerul din bază
 * (`household_members_guard_owner`, sub lock, pentru curse). Transferul e explicit:
 * `transferOwnership` promovează ținta și îl retrogradează pe owner, atomic.
 *
 * Plecarea / eliminarea (decizia mea, ADR 0016): blocate cât timp membrul are vreun sold reciproc
 * nenul (`balance_not_settled`; se decontează întâi, un owner poate înregistra decontarea).
 * Datele membrului RĂMÂN în gospodărie: tranzacțiile din conturile comune rămân ale tuturor;
 * conturile lui PERSONALE (și tot ce e legat de ele) devin invizibile pentru toți (nimeni altcineva
 * nu e proprietarul lor) și redevin vizibile doar dacă revine; regulile recurente pe ele nu se mai
 * generează (`due_recurring_rules` îl cere pe proprietar membru activ). Împărțirile și decontările
 * rămân în istoric. Ultimul membru nu „pleacă”: gospodăria se șterge separat.
 */

export async function listMembers(
  deps: FamilyDeps,
  actor: Actor,
  householdId: string,
): Promise<MemberView[]> {
  return inFamily(deps, actor, householdId, "member", (tx, m) => selectMembers(tx, m.householdId));
}

function lastOwner(): ConflictError {
  return new ConflictError(
    "last_owner",
    "Gospodăria trebuie să aibă un proprietar: transferă întâi rolul de proprietar.",
  );
}

export async function changeMemberRole(
  deps: FamilyDeps,
  actor: Actor,
  householdId: string,
  targetUserId: string,
  rawInput: unknown,
): Promise<MemberView> {
  if (!isValidId(targetUserId)) throw new NotFoundError();
  const input = parseInput(roleChangeSchema, rawInput);
  const target = targetUserId.toLowerCase();
  return inFamily(deps, actor, householdId, "owner", async (tx, m) => {
    await lockHouseholdMembers(tx, m.householdId);
    const member = await selectMember(tx, m.householdId, target);
    if (!member) throw new NotFoundError();
    if (member.role !== input.role) {
      if (member.role === "owner") {
        const owners = (await selectMembers(tx, m.householdId)).filter((x) => x.role === "owner");
        if (owners.length <= 1) throw lastOwner();
      }
      await updateMemberRole(tx, m.householdId, target, input.role);
      await insertAudit(tx, actor.userId, m.householdId, {
        action: "household.member_role_changed",
        targetType: "user",
        targetId: target,
        metadata: { role: input.role },
      });
    }
    const updated = (await selectMembers(tx, m.householdId)).find((x) => x.userId === target);
    if (!updated) throw new NotFoundError();
    return updated;
  });
}

/** Promovează `targetUserId` la owner și îl retrogradează pe actor la member, atomic. */
export async function transferOwnership(
  deps: FamilyDeps,
  actor: Actor,
  householdId: string,
  targetUserId: string,
): Promise<MemberView[]> {
  if (!isValidId(targetUserId)) throw new NotFoundError();
  const target = targetUserId.toLowerCase();
  if (target === actor.userId.toLowerCase()) {
    throw new ConflictError("same_member", "Alege alt membru.");
  }
  return inFamily(deps, actor, householdId, "owner", async (tx, m) => {
    await lockHouseholdMembers(tx, m.householdId);
    if (!(await selectMember(tx, m.householdId, target))) throw new NotFoundError();
    await updateMemberRole(tx, m.householdId, target, "owner");
    await updateMemberRole(tx, m.householdId, actor.userId, "member");
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "household.ownership_transferred",
      targetType: "user",
      targetId: target,
    });
    return selectMembers(tx, m.householdId);
  });
}

async function assertSettled(tx: Tx, householdId: string, userId: string) {
  const balances = await loadHouseholdBalances(tx, householdId);
  if (!isSettled(balances, userId)) {
    throw new ConflictError(
      "balance_not_settled",
      "Membrul are solduri nedecontate: înregistrează întâi decontările.",
    );
  }
}

/** Un owner scoate alt membru (pe sine: `leaveHousehold`). */
export async function removeMember(
  deps: FamilyDeps,
  actor: Actor,
  householdId: string,
  targetUserId: string,
): Promise<void> {
  if (!isValidId(targetUserId)) throw new NotFoundError();
  const target = targetUserId.toLowerCase();
  if (target === actor.userId.toLowerCase()) {
    throw new ConflictError("use_leave", "Pentru tine folosește „Părăsește gospodăria”.");
  }
  await inFamily(deps, actor, householdId, "owner", async (tx, m) => {
    await lockHouseholdMembers(tx, m.householdId);
    const member = await selectMember(tx, m.householdId, target);
    if (!member) throw new NotFoundError();
    await assertSettled(tx, m.householdId, target);
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "household.member_removed",
      targetType: "user",
      targetId: target,
    });
    if (!(await deleteMember(tx, m.householdId, target))) throw new NotFoundError();
  });
}

/** Utilizatorul pleacă din gospodărie. */
export async function leaveHousehold(
  deps: FamilyDeps,
  actor: Actor,
  householdId: string,
): Promise<void> {
  await inFamily(deps, actor, householdId, "member", async (tx, m) => {
    await lockHouseholdMembers(tx, m.householdId);
    const members = await selectMembers(tx, m.householdId);
    if (members.length <= 1) {
      throw new ConflictError(
        "sole_member",
        "Ești singurul membru: gospodăria nu se părăsește, se șterge.",
      );
    }
    if (m.role === "owner" && members.filter((x) => x.role === "owner").length <= 1) {
      throw lastOwner();
    }
    await assertSettled(tx, m.householdId, actor.userId);
    // Auditul ÎNAINTE de ștergere: după ea, utilizatorul nu mai e membru (RLS pe audit_events).
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "household.member_left",
      targetType: "user",
      targetId: actor.userId,
    });
    await clearActiveHouseholdIf(tx, actor.userId, m.householdId);
    if (!(await deleteMember(tx, m.householdId, actor.userId))) throw new NotFoundError();
  });
}

// --- gospodăria activă ------------------------------------------------------------------------

/** Gospodăriile utilizatorului, cu cea activă marcată (`current`). */
export async function listHouseholdsForSwitcher(
  deps: FamilyDeps,
  actor: Actor,
): Promise<HouseholdSummary[]> {
  return listMyHouseholds(deps.db, actor);
}

/**
 * Setează gospodăria activă. Apartenența se verifică în bază, în aceeași tranzacție cu scrierea
 * (o gospodărie străină sau inexistentă → 404 uniform). Preferința NU e o autorizare: la fiecare
 * cerere `currentHouseholdIdOf` o folosește doar dacă apartenența există încă.
 */
export async function setActiveHousehold(
  deps: FamilyDeps,
  actor: Actor,
  rawInput: unknown,
): Promise<HouseholdSummary> {
  const input = parseInput(activeHouseholdSchema, rawInput);
  try {
    await withMember(
      actor,
      input.householdId,
      "member",
      async (tx, m) => {
        await setActiveHouseholdRow(tx, actor.userId, m.householdId);
        await insertAudit(tx, actor.userId, m.householdId, {
          action: "household.switched",
          targetType: "household",
          targetId: m.householdId,
        });
      },
      { db: deps.db },
    );
  } catch (error) {
    if (error instanceof ForbiddenError) throw error;
    translateDbError(error);
  }
  const list = await listMyHouseholds(deps.db, actor);
  const found = list.find((h) => h.id === input.householdId);
  if (!found) throw new NotFoundError();
  return found;
}
