import "server-only";

import type { Tx } from "@/db";
import { type Actor, NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import type { Currency } from "@/lib/money";
import { insertAudit } from "@/modules/auth/audit";
import { selectAccount } from "@/modules/accounts/accounts.repo";
import { isValidId, parseInput } from "@/modules/ledger/input";
import { selectTransaction } from "@/modules/transactions/transactions.repo";

import { type FamilyDeps, inFamily } from "./context";
import { loadHouseholdBalances, lockHouseholdBalances } from "./settlements.service";
import {
  type SplitDbRow,
  deleteSplitRows,
  insertSplitRows,
  selectMembers,
  selectRecentSplitTransactionIds,
  selectSplitRows,
} from "./family.repo";
import {
  type SplitSetInput,
  type SplitView,
  splitListSchema,
  splitSetSchema,
} from "./family.schema";
import {
  type Share,
  SplitMathError,
  splitByBasisPoints,
  splitEqually,
  splitFixed,
  withinPairCap,
} from "./split-math";

/**
 * Împărțirea cheltuielilor între membri (Faza 8, ADR 0016).
 *
 * - Se împarte doar o CHELTUIALĂ dintr-un cont PERSONAL al celui care împarte: el e plătitorul
 *   (decizia mea: banii unui cont comun sunt deja ai tuturor, deci nu creează datorii între
 *   membri; datoria apare când cineva plătește din banii lui pentru gospodărie). Doar plătitorul
 *   setează sau șterge împărțirea (RLS: `payer_user_id = utilizatorul curent`).
 * - Moduri: egal, procente (puncte de bază, suma exact 10000), sume fixe (suma exact totalul);
 *   rotunjirea în `split-math.ts`. Participanții: 2–6 membri distincți ai gospodăriei (plătitorul
 *   poate fi sau nu printre ei; dacă nu e, ceilalți îi datorează tot).
 * - Suma părților = totalul: calculată exact aici și verificată din nou de bază la COMMIT
 *   (triggerul amânat `transaction_splits_sum_valid`). Cât timp împărțirea există, suma, contul și
 *   tipul tranzacției nu se schimbă (`updateTransaction` → 409 `transaction_split`).
 * - Vizibilitate: rândurile (cine, cât, cine a plătit) le văd toți membrii, ca soldurile să fie
 *   aceleași pentru toți; tranzacția (descriere, comerciant) și contul personal rămân ale
 *   plătitorului.
 */

function computeShares(input: SplitSetInput, total: bigint, currency: Currency): Share[] {
  try {
    switch (input.mode) {
      case "equal":
        return splitEqually(total, currency, input.userIds);
      case "percent":
        return splitByBasisPoints(
          total,
          currency,
          input.shares.map((s) => ({ userId: s.userId, value: BigInt(s.basisPoints) })),
        );
      case "fixed":
        return splitFixed(
          total,
          input.shares.map((s) => ({ userId: s.userId, value: BigInt(s.amountMinor) })),
        );
    }
  } catch (error) {
    if (error instanceof SplitMathError) {
      const messages: Record<SplitMathError["reason"], string> = {
        no_participants: "Alege cel puțin doi membri.",
        duplicate_participant: "Un membru apare de două ori.",
        percent_total: "Procentele trebuie să însumeze exact 100%.",
        fixed_total: "Sumele trebuie să însumeze exact totalul cheltuielii.",
        negative: "Sumele nu pot fi negative.",
      };
      throw new ValidationError({ shares: messages[error.reason] });
    }
    throw error;
  }
}

function toViews(rows: readonly SplitDbRow[]): SplitView[] {
  const byTx = new Map<string, SplitDbRow[]>();
  for (const r of rows) {
    const list = byTx.get(r.transactionId) ?? [];
    list.push(r);
    byTx.set(r.transactionId, list);
  }
  return [...byTx.entries()].map(([transactionId, list]) => ({
    transactionId,
    payerUserId: list[0]!.payerUserId,
    currency: list[0]!.currency,
    totalMinor: list.reduce((acc, r) => acc + r.shareMinor, 0n),
    shares: list.map((r) => ({ userId: r.userId, shareMinor: r.shareMinor })),
    createdAt: list.reduce((acc, r) => (r.createdAt > acc ? r.createdAt : acc), list[0]!.createdAt),
  }));
}

async function loadSplit(tx: Tx, householdId: string, transactionId: string) {
  return toViews(await selectSplitRows(tx, householdId, [transactionId]))[0] ?? null;
}

/** Setează (sau înlocuiește) împărțirea unei cheltuieli. */
export async function setTransactionSplit(
  deps: FamilyDeps,
  actor: Actor,
  householdId: string,
  transactionId: string,
  rawInput: unknown,
): Promise<SplitView> {
  if (!isValidId(transactionId)) throw new NotFoundError();
  const input = parseInput(splitSetSchema, rawInput);
  const id = transactionId.toLowerCase();
  return inFamily(deps, actor, householdId, "member", async (tx, m) => {
    // Invizibilă (contul personal al altuia) sau inexistentă: același 404.
    const t = await selectTransaction(tx, m.householdId, id, true);
    if (!t) throw new NotFoundError();
    if (t.type !== "expense") {
      throw new ConflictError("split_not_expense", "Doar cheltuielile se împart.");
    }
    const account = await selectAccount(tx, m.householdId, t.accountId);
    if (!account || account.ownerUserId !== actor.userId.toLowerCase()) {
      throw new ConflictError(
        "split_requires_personal_account",
        "Se împart doar cheltuielile plătite din contul tău personal.",
      );
    }
    const shares = computeShares(input, t.amountMinor, t.currency);
    const members = new Set((await selectMembers(tx, m.householdId)).map((x) => x.userId));
    if (shares.some((s) => !members.has(s.userId))) {
      throw new ValidationError({
        shares: "Toți participanții trebuie să fie membri ai gospodăriei.",
      });
    }
    await lockHouseholdBalances(tx, m.householdId);
    await deleteSplitRows(tx, m.householdId, id);
    await insertSplitRows(
      tx,
      shares.map((s) => ({
        householdId: m.householdId,
        transactionId: id,
        payerUserId: actor.userId.toLowerCase(),
        userId: s.userId,
        shareMinor: s.shareMinor,
        currency: t.currency,
      })),
    );
    // Plafonul soldurilor (revizuirea m4): nicio pereche a plătitorului peste PAIR_BALANCE_CAP.
    if (
      !withinPairCap(await loadHouseholdBalances(tx, m.householdId), actor.userId.toLowerCase())
    ) {
      throw new ConflictError("balance_limit", "Soldul dintre membri ar depăși plafonul permis.");
    }
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "transaction.split_set",
      targetType: "transaction",
      targetId: id,
      metadata: { mode: input.mode, participants: shares.length },
    });
    const view = await loadSplit(tx, m.householdId, id);
    if (!view) throw new NotFoundError();
    return view;
  });
}

/** Elimină împărțirea (doar plătitorul). */
export async function clearTransactionSplit(
  deps: FamilyDeps,
  actor: Actor,
  householdId: string,
  transactionId: string,
): Promise<void> {
  if (!isValidId(transactionId)) throw new NotFoundError();
  const id = transactionId.toLowerCase();
  await inFamily(deps, actor, householdId, "member", async (tx, m) => {
    const current = await loadSplit(tx, m.householdId, id);
    if (!current) throw new NotFoundError();
    if (current.payerUserId !== actor.userId.toLowerCase()) {
      throw new ConflictError("split_not_payer", "Doar cine a plătit modifică împărțirea.");
    }
    await lockHouseholdBalances(tx, m.householdId);
    await deleteSplitRows(tx, m.householdId, id);
    if (
      !withinPairCap(await loadHouseholdBalances(tx, m.householdId), actor.userId.toLowerCase())
    ) {
      throw new ConflictError("balance_limit", "Soldul dintre membri ar depăși plafonul permis.");
    }
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "transaction.split_cleared",
      targetType: "transaction",
      targetId: id,
    });
  });
}

/** Împărțirea unei tranzacții (orice membru; 404 dacă nu există). */
export async function getTransactionSplit(
  deps: FamilyDeps,
  actor: Actor,
  householdId: string,
  transactionId: string,
): Promise<SplitView> {
  if (!isValidId(transactionId)) throw new NotFoundError();
  return inFamily(deps, actor, householdId, "member", async (tx, m) => {
    const view = await loadSplit(tx, m.householdId, transactionId.toLowerCase());
    if (!view) throw new NotFoundError();
    return view;
  });
}

/** Ultimele împărțiri din gospodărie (cele mai noi întâi). */
export async function listSplits(
  deps: FamilyDeps,
  actor: Actor,
  householdId: string,
  rawOptions: unknown = {},
): Promise<SplitView[]> {
  const options = parseInput(splitListSchema, rawOptions) ?? {};
  return inFamily(deps, actor, householdId, "member", async (tx, m) => {
    const ids = await selectRecentSplitTransactionIds(tx, m.householdId, options.limit ?? 50);
    if (ids.length === 0) return [];
    const views = toViews(await selectSplitRows(tx, m.householdId, ids));
    const order = new Map(ids.map((tid, i) => [tid, i]));
    return views.sort((a, b) => order.get(a.transactionId)! - order.get(b.transactionId)!);
  });
}
