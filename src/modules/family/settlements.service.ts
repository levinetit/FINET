import "server-only";

import type { Tx } from "@/db";
import { sql } from "drizzle-orm";

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
import { type CurrencyBalances, computeBalances, pairDebt, withinPairCap } from "./split-math";

/**
 * Decontările și soldurile reciproce (Faza 8, ADR 0016, punctul 8).
 *
 * Permisiuni (decizia coordonatorului după revizuirea M2):
 * - orice membru înregistrează o decontare în care e una dintre părți; un `owner` o poate
 *   înregistra pentru oricare doi membri, dar DOAR ca stingere a unei datorii existente;
 * - cine declară că a PLĂTIT (`from`) poate stinge cel mult datoria lui curentă față de `to`
 *   (netting pe pereche, în moneda decontării): fără plată „peste datorie” și fără nicio plată
 *   dacă nu datorează nimic (nimeni nu își creează singur o creanță). Cine declară că a PRIMIT
 *   (`to`) poate înregistra orice sumă (doar în defavoarea lui); o „corecție” în favoarea
 *   creditorului o înregistrează deci debitorul, ca destinatar;
 * - anulează oricare dintre părți sau creatorul; un owner care nu e parte NU o anulează;
 *   anularea e definitivă (istoricul rămâne).
 * Aceleași reguli de cine scrie/anulează sunt în bază (politicile `settlements_*`); plafonul pe
 * datorie e în serviciu, sub lock-ul soldurilor gospodăriei.
 * Plafonul m4: soldul unei perechi rămâne ≤ `PAIR_BALANCE_CAP` după orice scriere.
 */

/** Serializează scrierile care schimbă soldurile gospodăriei (verificări fără curse). */
export async function lockHouseholdBalances(tx: Tx, householdId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`finet.family_balances:${householdId}`}))`,
  );
}

function balanceLimit(): ConflictError {
  return new ConflictError(
    "balance_limit",
    "Soldul dintre cei doi membri ar depăși plafonul permis.",
  );
}

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
    const current = new Set((await selectMembers(tx, m.householdId)).map((x) => x.userId));
    const former = new Set<string>();
    for (const c of currencies) {
      for (const x of c.members) if (!current.has(x.userId)) former.add(x.userId);
    }
    return {
      currencies,
      formerMemberIds: [...former].sort(),
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
    await lockHouseholdBalances(tx, m.householdId);
    const before = await loadHouseholdBalances(tx, m.householdId);
    // Datoria curentă a lui `from` față de `to` (negativă: `from` e creditorul).
    const debt = pairDebt(before, input.currency, input.fromUserId, input.toUserId);
    const allowed =
      me === input.toUserId || // a primit: orice sumă (doar în defavoarea lui)
      (debt > 0n && amountMinor <= debt); // plătitorul (sau un owner) stinge o datorie existentă
    if (!allowed) {
      throw new ConflictError(
        "settlement_exceeds_debt",
        "Poți înregistra o plată doar în limita datoriei tale curente; o sumă primită o înregistrează destinatarul.",
      );
    }
    const after = computeAfter(
      before,
      input.currency,
      input.fromUserId,
      input.toUserId,
      amountMinor,
    );
    if (!withinPairCap(after)) throw balanceLimit();
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
    const me = actor.userId.toLowerCase();
    if (![current.createdByUserId, current.fromUserId, current.toUserId].includes(me)) {
      throw new ForbiddenError();
    }
    if (current.cancelledAt) {
      throw new ConflictError("settlement_already_cancelled", "Decontarea e deja anulată.");
    }
    await lockHouseholdBalances(tx, m.householdId);
    // Anularea readuce datoria: soldul perechii trebuie să rămână sub plafon (m4).
    const before = await loadHouseholdBalances(tx, m.householdId);
    const after = computeAfter(
      before,
      current.currency,
      current.toUserId,
      current.fromUserId,
      current.amountMinor,
    );
    if (!withinPairCap(after)) throw balanceLimit();
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

/**
 * Soldurile după o decontare ipotetică `from → to` de `amount` (fără a scrie nimic): perechea
 * atinsă e recalculată exact ca în `computeBalances`.
 */
function computeAfter(
  before: readonly CurrencyBalances[],
  currency: SettlementView["currency"],
  from: string,
  to: string,
  amount: bigint,
): CurrencyBalances[] {
  const debt = pairDebt(before, currency, from, to) - amount;
  return [
    {
      currency,
      pairs:
        debt === 0n
          ? []
          : [
              debt > 0n
                ? { debtorUserId: from, creditorUserId: to, amountMinor: debt }
                : { debtorUserId: to, creditorUserId: from, amountMinor: -debt },
            ],
      members: [],
    },
  ];
}
