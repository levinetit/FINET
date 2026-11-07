import "server-only";

import type { Actor } from "@/lib/authz";
import { NotFoundError } from "@/lib/authz";
import {
  DEFAULT_TIME_ZONE,
  addMonths,
  currentMonth,
  localDateOf,
  monthBounds,
  monthsEndingAt,
} from "@/lib/calendar";
import { ValidationError } from "@/lib/errors";
import type { Currency } from "@/lib/money";
import { selectAccount, selectAccounts } from "@/modules/accounts/accounts.repo";
import { insertAudit } from "@/modules/auth/audit";
import { selectHouseholdTimeZone } from "@/modules/budgets/budgets.repo";
import type { PlanningDeps } from "@/modules/budgets/budgets.service";
import { sortCurrencies } from "@/modules/dashboard/dashboard.service";
import {
  HOUSEHOLD_CAPS,
  type LedgerDeps,
  assertUnderCap,
  inHousehold,
  lockHouseholdCap,
} from "@/modules/ledger/context";
import { parseInput, resolveAmount } from "@/modules/ledger/input";

import {
  type AccountMonthNet,
  type NetWorth,
  type NetWorthAccount,
  type Valuation,
  computeNetWorth,
  isValuedType,
} from "./net-worth";
import {
  type ValuationRow,
  deleteValuationRow,
  insertValuation,
  selectAccountMonthlyNets,
  selectAccountValuations,
  selectValuations,
} from "./net-worth.repo";
import {
  HISTORY_MONTHS_DEFAULT,
  type NetWorthView,
  type ValuationView,
  netWorthQuerySchema,
  valuationCreateSchema,
} from "./net-worth.schema";

/**
 * Averea netă (ADR 0046): toate conturile vizibile actorului (inclusiv cele arhivate: soldul lor
 * rămâne un activ/pasiv real), evaluările lor și netul lunar al tranzacțiilor, citite sub
 * `withMember` + RLS; calculul e pur (`net-worth.ts`). „Azi” e în fusul gospodăriei; istoricul
 * are `months` sfârșituri de lună (implicit 12), ultimul fiind azi.
 */

export function valuationView(row: ValuationRow): ValuationView {
  return {
    id: row.id,
    accountId: row.accountId,
    currency: row.currency,
    valuedOn: row.valuedOn,
    valueMinor: row.valueMinor,
    note: row.note,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
  };
}

export async function getNetWorth(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown = {},
): Promise<NetWorthView> {
  const input = parseInput(netWorthQuerySchema, rawInput) ?? {};
  const months = input.months ?? HISTORY_MONTHS_DEFAULT;
  const now = deps.now ?? (() => new Date());
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const tz = (await selectHouseholdTimeZone(tx, m.householdId)) ?? DEFAULT_TIME_ZONE;
    const instant = now();
    const asOf = localDateOf(instant, tz);
    const monthEnds = monthsEndingAt(currentMonth(instant, tz), months).map(
      (mo) => monthBounds(mo).to,
    );
    const [rows, valuationRows, netRows] = await Promise.all([
      selectAccounts(tx, m.householdId, { includeArchived: true }),
      selectValuations(tx, m.householdId),
      selectAccountMonthlyNets(tx, m.householdId, asOf),
    ]);
    const accounts: NetWorthAccount[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      currency: r.currency,
      openingBalanceMinor: r.openingBalanceMinor,
      archivedAt: r.archivedAt,
    }));
    const valuations: Valuation[] = valuationRows.map((v) => ({
      accountId: v.accountId,
      valuedOn: v.valuedOn,
      valueMinor: v.valueMinor,
    }));
    const nets: AccountMonthNet[] = netRows.map((n) => ({
      accountId: n.accountId,
      month: n.month,
      netMinor: BigInt(n.net),
    }));
    const currencies = sortCurrencies(accounts.map((a) => a.currency));
    const result: NetWorth[] = currencies.map((currency) =>
      computeNetWorth({
        currency,
        asOf,
        monthEnds,
        accounts: accounts.filter((a) => a.currency === currency),
        valuations,
        nets,
      }),
    );
    return { asOf, currencies: result };
  });
}

/** Lunile anterioare lunii curente nu se pot evalua „în viitor”: data trebuie să fie ≤ azi. */
export async function listValuations(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  accountId: string,
): Promise<ValuationView[]> {
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const account = await selectAccount(tx, m.householdId, accountId);
    if (!account) throw new NotFoundError();
    return (await selectAccountValuations(tx, m.householdId, accountId)).map(valuationView);
  });
}

export async function addValuation(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  accountId: string,
  rawInput: unknown,
): Promise<ValuationView> {
  const input = parseInput(valuationCreateSchema, rawInput);
  const now = deps.now ?? (() => new Date());
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const account = await selectAccount(tx, m.householdId, accountId);
    if (!account) throw new NotFoundError();
    if (!isValuedType(account.type)) {
      throw new ValidationError({
        accountId:
          "Doar conturile evaluate (investiții, proprietăți, vehicule, credite, altele) primesc evaluări; soldul celorlalte vine din tranzacții.",
      });
    }
    const tz = (await selectHouseholdTimeZone(tx, m.householdId)) ?? DEFAULT_TIME_ZONE;
    const today = localDateOf(now(), tz);
    if (input.valuedOn > today) {
      throw new ValidationError({ valuedOn: "Data evaluării nu poate fi în viitor." });
    }
    if (input.valuedOn < monthBounds(addMonths(currentMonth(now(), tz), -120)).from) {
      throw new ValidationError({ valuedOn: "Data evaluării e prea veche (cel mult 10 ani)." });
    }
    await lockHouseholdCap(tx, "valuations", m.householdId);
    assertUnderCap(
      (await selectAccountValuations(tx, m.householdId, account.id)).length,
      HOUSEHOLD_CAPS.valuationsPerAccount,
      "evaluări pe cont",
    );
    const valueMinor = resolveAmount(
      { amountMinor: input.valueMinor, amount: input.value },
      account.currency as Currency,
      "valueMinor",
      true,
    );
    const row = await insertValuation(tx, {
      householdId: m.householdId,
      accountId: account.id,
      currency: account.currency,
      valuedOn: input.valuedOn,
      valueMinor,
      note: input.note ?? null,
      createdByUserId: actor.userId,
    });
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "valuation.created",
      targetType: "account",
      targetId: account.id,
    });
    return valuationView(row);
  });
}

export async function deleteValuation(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  accountId: string,
  valuationId: string,
): Promise<void> {
  await inHousehold(deps, actor, householdId, async (tx, m) => {
    const account = await selectAccount(tx, m.householdId, accountId);
    if (!account) throw new NotFoundError();
    const deleted = await deleteValuationRow(tx, m.householdId, accountId, valuationId);
    if (!deleted) throw new NotFoundError();
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "valuation.deleted",
      targetType: "account",
      targetId: account.id,
    });
  });
}
