import "server-only";

import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";

import { accounts, recurringRules, recurringSuggestionDismissals, transactions } from "@/db/schema";
import { type Actor, NotFoundError } from "@/lib/authz";
import { addDays } from "@/lib/calendar";
import type { Currency } from "@/lib/money";
import { insertAudit } from "@/modules/auth/audit";
import { type LedgerDeps, inHousehold } from "@/modules/ledger/context";
import { parseInput } from "@/modules/ledger/input";

import type { RecurringRuleView } from "./recurring.schema";
import { acceptSuggestionSchema, signatureSchema } from "./suggestions.schema";
import { createRecurringRule, todayLocal } from "./recurring.service";
import { type RecurringSuggestion, detectRecurring } from "./suggestions";

/**
 * Propunerile de plăți recurente (F7-B; ADR 0019): calculate la cerere din istoricul VIZIBIL
 * membrului (RLS: tranzacțiile dintr-un cont personal al altui membru nu intră), fără să creeze
 * ceva. Acceptarea creează o regulă prin serviciul Fazei 5 (aceleași validări), după ce propunerea
 * e RECALCULATĂ pe server (clientul trimite doar amprenta; suma și contul vin din istoric).
 * Respingerea memorează doar amprenta (pe cont).
 */

export const HISTORY_DAYS = 400;
const HISTORY_LIMIT = 20_000;
export const SUGGESTION_LIMIT = 50;

export type SuggestionView = RecurringSuggestion & Readonly<{ accountName: string }>;

type Deps = LedgerDeps & Readonly<{ now?: () => Date }>;

async function compute(deps: Deps, actor: Actor, householdId: string): Promise<SuggestionView[]> {
  const today = todayLocal((deps.now ?? (() => new Date()))());
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const hh = m.householdId;
    const history = await tx
      .select({
        accountId: transactions.accountId,
        type: transactions.type,
        currency: transactions.currency,
        amountMinor: transactions.amountMinor,
        occurredOn: transactions.occurredOn,
        description: transactions.description,
        merchant: transactions.merchant,
        categoryId: transactions.categoryId,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.householdId, hh),
          inArray(transactions.type, ["income", "expense"]),
          gte(transactions.occurredOn, addDays(today, -HISTORY_DAYS)),
        ),
      )
      .orderBy(transactions.occurredOn)
      .limit(HISTORY_LIMIT);
    const rules = await tx
      .select({
        accountId: recurringRules.accountId,
        type: recurringRules.type,
        currency: recurringRules.currency,
        amountMinor: recurringRules.amountMinor,
        frequency: recurringRules.frequency,
        description: recurringRules.description,
        merchant: recurringRules.merchant,
      })
      .from(recurringRules)
      .where(and(eq(recurringRules.householdId, hh), ne(recurringRules.status, "completed")));
    const dismissed = await tx
      .select({ signature: recurringSuggestionDismissals.signature })
      .from(recurringSuggestionDismissals)
      .where(eq(recurringSuggestionDismissals.householdId, hh));
    const names = await tx
      .select({ id: accounts.id, name: accounts.name, archivedAt: accounts.archivedAt })
      .from(accounts)
      .where(eq(accounts.householdId, hh));
    const open = new Map(names.filter((a) => a.archivedAt === null).map((a) => [a.id, a.name]));
    const list = detectRecurring(
      history.filter((t): t is typeof t & { type: "income" | "expense" } => t.type !== "transfer"),
      rules,
      today,
      new Set(dismissed.map((d) => d.signature)),
    );
    return list
      .filter((s) => open.has(s.accountId))
      .slice(0, SUGGESTION_LIMIT)
      .map((s) => ({ ...s, accountName: open.get(s.accountId)! }));
  });
}

export function listRecurringSuggestions(deps: Deps, actor: Actor, householdId: string) {
  return compute(deps, actor, householdId);
}

async function findSuggestion(deps: Deps, actor: Actor, householdId: string, signature: string) {
  if (!signatureSchema.safeParse(signature).success) throw new NotFoundError();
  const found = (await compute(deps, actor, householdId)).find((s) => s.signature === signature);
  if (!found) throw new NotFoundError();
  return found;
}

export async function acceptRecurringSuggestion(
  deps: Deps,
  actor: Actor,
  householdId: string,
  signature: string,
  rawInput: unknown = {},
): Promise<RecurringRuleView> {
  const input = parseInput(acceptSuggestionSchema, rawInput);
  if (!signatureSchema.safeParse(signature).success) throw new NotFoundError();
  const today = todayLocal((deps.now ?? (() => new Date()))());
  // Două acceptări simultane (fără `Idempotency-Key`) nu creează două reguli (revizuirea F7-B,
  // m2): blocare pe amprentă în tranzacția creării; propunerea se recalculează SUB blocare, deci
  // a doua cerere vede regula deja creată („acoperită”) și primește 404.
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`finet.suggestion:${m.householdId}:${signature}`}, 0))`,
    );
    const inner = { ...deps, db: tx };
    const s = await findSuggestion(inner, actor, m.householdId, signature);
    return createRecurringRule(
      inner,
      actor,
      m.householdId,
      {
        accountId: s.accountId,
        categoryId: s.categoryId,
        type: s.type,
        amountMinor: Number(s.amountMinor),
        description: s.description,
        ...(s.merchant ? { merchant: s.merchant } : {}),
        frequency: s.frequency,
        startOn: input.startOn ?? s.nextOn,
      },
      today,
    );
  });
}

export async function dismissRecurringSuggestion(
  deps: Deps,
  actor: Actor,
  householdId: string,
  signature: string,
): Promise<void> {
  if (!signatureSchema.safeParse(signature).success) throw new NotFoundError();
  // Idempotent: o propunere deja respinsă (vizibilă: contul ei e vizibil) nu mai e calculată.
  const already = await inHousehold(deps, actor, householdId, (tx, m) =>
    tx
      .select({ s: recurringSuggestionDismissals.signature })
      .from(recurringSuggestionDismissals)
      .where(
        and(
          eq(recurringSuggestionDismissals.householdId, m.householdId),
          eq(recurringSuggestionDismissals.signature, signature),
        ),
      )
      .limit(1),
  );
  if (already.length) return;
  const s = await findSuggestion(deps, actor, householdId, signature);
  await inHousehold(deps, actor, householdId, async (tx, m) => {
    await tx
      .insert(recurringSuggestionDismissals)
      .values({
        householdId: m.householdId,
        accountId: s.accountId,
        currency: s.currency as Currency,
        signature: s.signature,
        dismissedByUserId: actor.userId,
      })
      .onConflictDoNothing();
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "recurring.suggestion_dismissed",
      targetType: "account",
      targetId: s.accountId,
    });
  });
}
