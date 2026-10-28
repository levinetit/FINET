import "server-only";

import type { Tx } from "@/db";
import { type Actor, NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { type Currency, add, money, percentOf, sub } from "@/lib/money";
import { selectAccount } from "@/modules/accounts/accounts.repo";
import { insertAudit } from "@/modules/auth/audit";
import { type LedgerDeps, inHousehold } from "@/modules/ledger/context";
import {
  MAX_AMOUNT_MINOR,
  isValidId,
  parseInput,
  resolvePositiveAmount,
} from "@/modules/ledger/input";

import {
  type GoalRow,
  deleteGoalRow,
  insertGoal,
  selectGoal,
  selectGoals,
  updateGoalRow,
} from "./goals.repo";
import {
  type GoalStatus,
  type GoalView,
  goalContributionSchema,
  goalCreateSchema,
  goalListSchema,
  goalUpdateSchema,
} from "./goals.schema";

/**
 * Obiectivele (Faza 3): CRUD, progres și contribuții (ADR 0007).
 * - `saved_minor` nu scade sub 0 (o retragere mai mare → 409 `goal_saved_negative`) și nu trece de
 *   plafonul sumelor (10^13 → 400);
 * - starea: `achieved` ⇔ economisit ≥ țintă, calculată la fiecare schimbare (contribuție sau țintă
 *   nouă), deci și REVERSIBILĂ (o retragere sub țintă îl readuce la `active`); `abandoned` e doar
 *   manual și „îngheață” obiectivul (contribuțiile → 409 `goal_abandoned`), iar reluarea
 *   (`status: "active"`) recalculează starea. CHECK-ul `goals_status_progress` din bază păzește
 *   aceeași regulă;
 * - ștergerea e definitivă, cu `audit_event` fără sume; confirmarea o cere API-ul.
 */

const CAP = BigInt(MAX_AMOUNT_MINOR);

/** Starea după regula progresului (abandonat rămâne abandonat). */
export function deriveStatus(
  current: GoalStatus,
  savedMinor: bigint,
  targetMinor: bigint,
): GoalStatus {
  if (current === "abandoned") return "abandoned";
  return savedMinor >= targetMinor ? "achieved" : "active";
}

function view(row: GoalRow): GoalView {
  return {
    id: row.id,
    name: row.name,
    targetMinor: row.targetMinor,
    savedMinor: row.savedMinor,
    currency: row.currency,
    deadline: row.deadline,
    status: row.status,
    accountId: row.accountId,
    progressPct: percentOf(row.savedMinor, row.targetMinor, "floor") ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function checkAccount(
  tx: Tx,
  householdId: string,
  accountId: string | null | undefined,
  currency: Currency,
): Promise<void> {
  if (!accountId) return;
  const account = await selectAccount(tx, householdId, accountId);
  if (!account) throw new NotFoundError();
  if (account.currency !== currency) {
    throw new ValidationError({ accountId: "Contul are altă monedă decât obiectivul." });
  }
}

function resolveTarget(input: { targetMinor?: number; target?: string }, currency: Currency) {
  return resolvePositiveAmount(
    { amountMinor: input.targetMinor, amount: input.target },
    currency,
    "targetMinor",
  );
}

export async function listGoals(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  rawOptions: unknown = {},
): Promise<GoalView[]> {
  const options = parseInput(goalListSchema, rawOptions) ?? {};
  return inHousehold(deps, actor, householdId, async (tx, m) =>
    (await selectGoals(tx, m.householdId, options.status)).map(view),
  );
}

export async function getGoal(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  goalId: string,
): Promise<GoalView> {
  if (!isValidId(goalId)) throw new NotFoundError();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const row = await selectGoal(tx, m.householdId, goalId.toLowerCase());
    if (!row) throw new NotFoundError();
    return view(row);
  });
}

export async function createGoal(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown,
): Promise<GoalView> {
  const input = parseInput(goalCreateSchema, rawInput);
  const targetMinor = resolveTarget(input, input.currency);
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    await checkAccount(tx, m.householdId, input.accountId, input.currency);
    const row = await insertGoal(tx, {
      householdId: m.householdId,
      name: input.name,
      targetMinor,
      currency: input.currency,
      savedMinor: 0n,
      deadline: input.deadline ?? null,
      status: "active",
      accountId: input.accountId ?? null,
    });
    return view(row);
  });
}

export async function updateGoal(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  goalId: string,
  rawPatch: unknown,
): Promise<GoalView> {
  if (!isValidId(goalId)) throw new NotFoundError();
  const patch = parseInput(goalUpdateSchema, rawPatch);
  const id = goalId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await selectGoal(tx, m.householdId, id, true);
    if (!current) throw new NotFoundError();
    if (patch.accountId !== undefined) {
      await checkAccount(tx, m.householdId, patch.accountId, current.currency);
    }
    const targetMinor =
      patch.targetMinor !== undefined || patch.target !== undefined
        ? resolveTarget(patch, current.currency)
        : current.targetMinor;
    // Reluarea (`active`) pornește din regula progresului; `abandoned` e explicit.
    const base: GoalStatus =
      patch.status === "abandoned"
        ? "abandoned"
        : patch.status === "active"
          ? "active"
          : current.status;
    const status = deriveStatus(base, current.savedMinor, targetMinor);
    const row = await updateGoalRow(tx, m.householdId, id, {
      name: patch.name,
      targetMinor,
      deadline: patch.deadline,
      accountId: patch.accountId,
      status,
    });
    if (!row) throw new NotFoundError();
    return view(row);
  });
}

/** Adaugă la economisit sau scoate din el; recalculează starea (inclusiv înapoi la `active`). */
export async function contributeToGoal(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  goalId: string,
  rawInput: unknown,
): Promise<GoalView> {
  if (!isValidId(goalId)) throw new NotFoundError();
  const input = parseInput(goalContributionSchema, rawInput);
  const id = goalId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await selectGoal(tx, m.householdId, id, true);
    if (!current) throw new NotFoundError();
    if (current.status === "abandoned") {
      throw new ConflictError("goal_abandoned", "Obiectivul e abandonat; reia-l întâi.");
    }
    const amount = money(resolvePositiveAmount(input, current.currency), current.currency);
    const saved = money(current.savedMinor, current.currency);
    const next = input.direction === "add" ? add(saved, amount) : sub(saved, amount);
    if (next.amountMinor < 0n) {
      throw new ConflictError(
        "goal_saved_negative",
        "Nu poți retrage mai mult decât ai economisit.",
      );
    }
    if (next.amountMinor > CAP) throw new ValidationError({ amountMinor: "Suma este prea mare." });
    const row = await updateGoalRow(tx, m.householdId, id, {
      savedMinor: next.amountMinor,
      status: deriveStatus(current.status, next.amountMinor, current.targetMinor),
    });
    if (!row) throw new NotFoundError();
    return view(row);
  });
}

export async function deleteGoal(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  goalId: string,
): Promise<void> {
  if (!isValidId(goalId)) throw new NotFoundError();
  const id = goalId.toLowerCase();
  await inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await selectGoal(tx, m.householdId, id, true);
    if (!current) throw new NotFoundError();
    if (!(await deleteGoalRow(tx, m.householdId, id))) throw new NotFoundError();
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "goal.deleted",
      targetType: "goal",
      targetId: id,
      metadata: { status: current.status },
    });
  });
}
