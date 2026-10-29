import "server-only";

import type { Tx } from "@/db";
import { type Actor, ForbiddenError, NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { insertAudit } from "@/modules/auth/audit";
import { isValidId, parseInput, resolvePositiveAmount } from "@/modules/ledger/input";

import { type FamilyDeps, inFamily, nowOf } from "./context";
import {
  cancelSettlementRow,
  insertSettlement,
  selectActiveSettlementRows,
  selectMembers,
  selectSettlement,
  selectSettlements,
  selectSplitRows,
} from "./family.repo";
import {
  type BalancesView,
  type SettlementView,
  settlementCreateSchema,
  settlementListSchema,
} from "./family.schema";
import { type CurrencyBalances, computeBalances } from "./split-math";

/**
 * Decontările și soldurile reciproce (Faza 8, ADR 0016).
 *
 * Permisiuni (decizia mea): orice membru înregistrează o decontare în care e una dintre părți
 * (plătitor sau primitor); un `owner` o poate înregistra pentru oricare doi membri (de exemplu
 * pentru cineva fără cont activ în aplicație). Anulează creatorul sau un `owner`; anularea e
 * definitivă (istoricul rămâne). Aceleași reguli în bază (politicile `settlements_*`).
 * O decontare parțială = o decontare cu o sumă mai mică decât soldul; mai multe decontări se
 * adună. Soldurile se calculează în cod (`computeBalances`, `bigint`), din împărțiri și din
 * decontările neanulate, pe monedă, fără conversie.
 */

/** Soldurile gospodăriei (toate perechile, toate monedele). Vizibile tuturor membrilor. */
export async function loadHouseholdBalances(
  tx: Tx,
  householdId: string,
): Promise<CurrencyBalances[]> {
  const splits = await selectSplitRows(tx, householdId);
  const settled = await selectActiveSettlementRows(tx, householdId);
  return computeBalances(splits, settled);
}

export async function getBalances(
  deps: FamilyDeps,
  actor: Actor,
  householdId: string,
): Promise<BalancesView> {
  return inFamily(deps, actor, householdId, "member", async (tx, m) => {
    const currencies = await loadHouseholdBalances(tx, m.householdId);
    const me = actor.userId.toLowerCase();
    return {
      currencies,
      me: currencies.map((c) => {
        let owesMinor = 0n;
        let owedMinor = 0n;
        for (const p of c.pairs) {
          if (p.debtorUserId === me) owesMinor += p.amountMinor;
          if (p.creditorUserId === me) owedMinor += p.amountMinor;
        }
        return { currency: c.currency, owesMinor, owedMinor };
      }),
    };
  });
}

export async function createSettlement(
  deps: FamilyDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown,
): Promise<SettlementView> {
  const input = parseInput(settlementCreateSchema, rawInput);
  const amountMinor = resolvePositiveAmount(input, input.currency);
  return inFamily(deps, actor, householdId, "member", async (tx, m) => {
    const me = actor.userId.toLowerCase();
    if (m.role !== "owner" && input.fromUserId !== me && input.toUserId !== me) {
      throw new ForbiddenError();
    }
    const members = new Set((await selectMembers(tx, m.householdId)).map((x) => x.userId));
    if (!members.has(input.fromUserId) || !members.has(input.toUserId)) {
      throw new ValidationError({ _: "Ambii utilizatori trebuie să fie membri ai gospodăriei." });
    }
    const row = await insertSettlement(tx, {
      householdId: m.householdId,
      fromUserId: input.fromUserId,
      toUserId: input.toUserId,
      amountMinor,
      currency: input.currency,
      settledOn: input.settledOn,
      note: input.note ?? null,
      createdByUserId: actor.userId,
    });
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "settlement.created",
      targetType: "settlement",
      targetId: row.id,
    });
    return row;
  });
}

export async function listSettlements(
  deps: FamilyDeps,
  actor: Actor,
  householdId: string,
  rawOptions: unknown = {},
): Promise<SettlementView[]> {
  const options = parseInput(settlementListSchema, rawOptions) ?? {};
  return inFamily(deps, actor, householdId, "member", (tx, m) =>
    selectSettlements(tx, m.householdId, {
      includeCancelled: options.includeCancelled ?? false,
      limit: options.limit ?? 100,
    }),
  );
}

export async function cancelSettlement(
  deps: FamilyDeps,
  actor: Actor,
  householdId: string,
  settlementId: string,
): Promise<SettlementView> {
  if (!isValidId(settlementId)) throw new NotFoundError();
  const id = settlementId.toLowerCase();
  return inFamily(deps, actor, householdId, "member", async (tx, m) => {
    const current = await selectSettlement(tx, m.householdId, id);
    if (!current) throw new NotFoundError();
    if (m.role !== "owner" && current.createdByUserId !== actor.userId.toLowerCase()) {
      throw new ForbiddenError();
    }
    if (current.cancelledAt) {
      throw new ConflictError("settlement_already_cancelled", "Decontarea e deja anulată.");
    }
    const row = await cancelSettlementRow(tx, m.householdId, id, actor.userId, nowOf(deps));
    if (!row) {
      throw new ConflictError("settlement_already_cancelled", "Decontarea e deja anulată.");
    }
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "settlement.cancelled",
      targetType: "settlement",
      targetId: id,
    });
    return row;
  });
}
