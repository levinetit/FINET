import "server-only";

import { randomUUID } from "node:crypto";

import type { Tx } from "@/db";
import { type Actor, NotFoundError } from "@/lib/authz";
import {
  DEFAULT_TIME_ZONE,
  addDays,
  type RecurrenceSpec,
  localDateOf,
  occurrenceAfter,
  occurrenceOnOrAfter,
} from "@/lib/calendar";
import { ConflictError, ValidationError } from "@/lib/errors";
import { MoneyOverflowError } from "@/lib/money";
import { selectAccount } from "@/modules/accounts/accounts.repo";
import { insertAudit } from "@/modules/auth/audit";
import { selectCategory } from "@/modules/categories/categories.repo";
import { type LedgerDeps, inHousehold } from "@/modules/ledger/context";
import { isValidId, parseInput, resolvePositiveAmount } from "@/modules/ledger/input";
import { assertAccountsWithinJsonRange } from "@/modules/ledger/range-guard";
import { insertTransactionRow } from "@/modules/transactions/transactions.repo";

import {
  type DueRule,
  type RecurringRuleRow,
  type RulePatch,
  claimOccurrence,
  countRules,
  deleteRuleRow,
  insertRule,
  lastOccurrenceDate,
  lockRuleForGeneration,
  selectDueRuleIds,
  selectDueRules,
  selectRule,
  selectRules,
  updateRuleRow,
} from "./recurring.repo";
import {
  type GenerateResult,
  MAX_CATCH_UP_PER_RUN,
  type RecurringList,
  type RecurringRuleView,
  recurringCreateSchema,
  recurringListSchema,
  recurringUpdateSchema,
} from "./recurring.schema";

/**
 * Regulile recurente (Faza 5; ADR 0011): CRUD, pauză/reluare și generarea idempotentă a
 * tranzacțiilor scadente.
 *
 * Idempotența: fiecare scadență se „revendică” întâi în `recurring_occurrences` (cheia primară
 * `(rule_id, occurrence_date)`); doar dacă revendicarea reușește se creează tranzacția, în ACEEAȘI
 * tranzacție SQL (o eroare la oricare rând anulează tot lotul regulii). Regula e blocată
 * `FOR UPDATE SKIP LOCKED`, deci o generare paralelă nu așteaptă și nu dublează.
 *
 * Calendarul: `src/lib/calendar.ts` (ziua 31 → ultima zi a lunii, 29 feb → 28 feb, fără deplasarea
 * zilei țintă). „Azi” e data locală din `Europe/Bucharest`.
 */

/** Data locală de azi (implicit în București). */
export function todayLocal(now: Date = new Date(), timeZone = DEFAULT_TIME_ZONE): string {
  return localDateOf(now, timeZone);
}

/** Pauza de reîncercare după o generare eșuată (decizia mea, ADR 0011). */
export const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

function specOf(
  r: Pick<RecurringRuleRow, "frequency" | "interval" | "dayOfMonth" | "startOn">,
): RecurrenceSpec {
  return {
    frequency: r.frequency,
    interval: r.interval,
    dayOfMonth: r.dayOfMonth,
    startOn: r.startOn,
  };
}

export function ruleView(row: RecurringRuleRow, today: string): RecurringRuleView {
  return {
    id: row.id,
    accountId: row.accountId,
    categoryId: row.categoryId,
    type: row.type,
    amountMinor: row.amountMinor,
    currency: row.currency,
    description: row.description,
    merchant: row.merchant,
    frequency: row.frequency,
    interval: row.interval,
    dayOfMonth: row.dayOfMonth,
    startOn: row.startOn,
    nextRunOn: row.nextRunOn,
    endOn: row.endOn,
    maxOccurrences: row.maxOccurrences,
    occurrencesCount: row.occurrencesCount,
    status: row.status,
    due: row.status === "active" && row.nextRunOn <= today,
    lastErrorCode: row.lastErrorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Regula e terminată: după `end_on` sau după numărul de rate. */
function isFinished(
  next: string | null,
  endOn: string | null,
  count: number,
  max: number | null,
): boolean {
  return next === null || (endOn !== null && next > endOn) || (max !== null && count >= max);
}

async function requireOpenAccount(tx: Tx, householdId: string, accountId: string) {
  const account = await selectAccount(tx, householdId, accountId);
  if (!account) throw new NotFoundError();
  if (account.archivedAt) {
    throw new ConflictError("account_archived", "Contul e arhivat și nu mai primește tranzacții.");
  }
  return account;
}

async function checkCategory(
  tx: Tx,
  householdId: string,
  categoryId: string | null | undefined,
  type: "income" | "expense",
): Promise<void> {
  if (!categoryId) return;
  const category = await selectCategory(tx, householdId, categoryId);
  if (!category) throw new NotFoundError();
  if (category.kind !== type) {
    throw new ValidationError({ categoryId: "Categoria are alt tip decât regula." });
  }
}

function noOccurrence(): never {
  throw new ValidationError({ _: "Regula nu are nicio scadență în intervalul ales." });
}

export async function createRecurringRule(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown,
): Promise<RecurringRuleView> {
  const input = parseInput(recurringCreateSchema, rawInput);
  const usesDay = input.frequency === "monthly" || input.frequency === "yearly";
  const dayOfMonth = usesDay ? (input.dayOfMonth ?? Number(input.startOn.slice(8, 10))) : null;
  const interval = input.interval ?? 1;
  const endOn = input.endOn ?? null;
  const first = occurrenceOnOrAfter(
    { frequency: input.frequency, interval, dayOfMonth, startOn: input.startOn },
    input.startOn,
  );
  if (first === null || (endOn !== null && first > endOn)) noOccurrence();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const account = await requireOpenAccount(tx, m.householdId, input.accountId);
    const amountMinor = resolvePositiveAmount(input, account.currency);
    await checkCategory(tx, m.householdId, input.categoryId, input.type);
    const row = await insertRule(tx, {
      householdId: m.householdId,
      accountId: account.id,
      categoryId: input.categoryId ?? null,
      type: input.type,
      amountMinor,
      currency: account.currency,
      description: input.description,
      merchant: input.merchant ?? null,
      frequency: input.frequency,
      interval,
      dayOfMonth,
      startOn: input.startOn,
      nextRunOn: first,
      endOn,
      maxOccurrences: input.maxOccurrences ?? null,
      createdByUserId: actor.userId,
    });
    return ruleView(row, todayLocal());
  });
}

export async function getRecurringRule(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  ruleId: string,
  today: string = todayLocal(),
): Promise<RecurringRuleView> {
  if (!isValidId(ruleId)) throw new NotFoundError();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const row = await selectRule(tx, m.householdId, ruleId.toLowerCase());
    if (!row) throw new NotFoundError();
    return ruleView(row, today);
  });
}

/** Lista (filtru opțional pe stare) și contorul „active · de generat · total” (pe toate). */
export async function listRecurringRules(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  rawQuery: unknown = {},
  today: string = todayLocal(),
): Promise<RecurringList> {
  const query = parseInput(recurringListSchema, rawQuery) ?? {};
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const rows = await selectRules(tx, m.householdId, query.status);
    const counts = await countRules(tx, m.householdId, today);
    return { data: rows.map((r) => ruleView(r, today)), counts };
  });
}

/**
 * Modificare. O schimbare a calendarului (frecvență, interval, zi) recalculează scadența de la
 * max(azi, ultima ocurență generată + 1 zi): nimic retroactiv, nimic dublat. O regulă terminată
 * redevine activă doar prin reluare, dacă mai are scadențe.
 */
export async function updateRecurringRule(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  ruleId: string,
  rawPatch: unknown,
  today: string = todayLocal(),
): Promise<RecurringRuleView> {
  if (!isValidId(ruleId)) throw new NotFoundError();
  const patch = parseInput(recurringUpdateSchema, rawPatch);
  const id = ruleId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await selectRule(tx, m.householdId, id, true);
    if (!current) throw new NotFoundError();
    const set: RulePatch = {};
    let currency = current.currency;
    if (patch.accountId && patch.accountId !== current.accountId) {
      const account = await requireOpenAccount(tx, m.householdId, patch.accountId);
      set.accountId = account.id;
      set.currency = account.currency;
      currency = account.currency;
    }
    if (
      currency !== current.currency &&
      patch.amountMinor === undefined &&
      patch.amount === undefined
    ) {
      throw new ConflictError(
        "currency_change_requires_amount",
        "Contul nou are altă monedă: trimite și suma în moneda lui.",
      );
    }
    if (patch.amountMinor !== undefined || patch.amount !== undefined) {
      set.amountMinor = resolvePositiveAmount(patch, currency);
    }
    if (patch.categoryId !== undefined) {
      await checkCategory(tx, m.householdId, patch.categoryId, current.type);
      set.categoryId = patch.categoryId;
    }
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.merchant !== undefined) set.merchant = patch.merchant;

    const frequency = patch.frequency ?? current.frequency;
    const usesDay = frequency === "monthly" || frequency === "yearly";
    let dayOfMonth = patch.dayOfMonth === undefined ? current.dayOfMonth : patch.dayOfMonth;
    if (!usesDay) {
      if (patch.dayOfMonth !== undefined && patch.dayOfMonth !== null) {
        throw new ValidationError({
          dayOfMonth: "Ziua din lună se dă doar pentru regulile lunare sau anuale.",
        });
      }
      dayOfMonth = null;
    } else if (dayOfMonth === null) {
      dayOfMonth = Number(current.startOn.slice(8, 10));
    }
    const interval = patch.interval ?? current.interval;
    const endOn = patch.endOn === undefined ? current.endOn : patch.endOn;
    if (endOn !== null && endOn < current.startOn) {
      throw new ValidationError({ endOn: "Data de sfârșit e înaintea datei de început." });
    }
    const maxOccurrences =
      patch.maxOccurrences === undefined ? current.maxOccurrences : patch.maxOccurrences;
    if (maxOccurrences !== null && maxOccurrences < current.occurrencesCount) {
      throw new ValidationError({
        maxOccurrences: "Regula a generat deja mai multe rate decât noul număr.",
      });
    }
    const scheduleChanged =
      frequency !== current.frequency ||
      interval !== current.interval ||
      dayOfMonth !== current.dayOfMonth;
    let nextRunOn = current.nextRunOn;
    if (scheduleChanged) {
      const last = await lastOccurrenceDate(tx, m.householdId, id);
      const spec = { frequency, interval, dayOfMonth, startOn: current.startOn };
      const from = [today, current.startOn, last ? addOneDay(last) : current.startOn]
        .sort()
        .at(-1)!;
      const next = occurrenceOnOrAfter(spec, from);
      if (next === null) noOccurrence();
      nextRunOn = next;
    }
    Object.assign(set, {
      frequency,
      interval,
      dayOfMonth,
      endOn,
      maxOccurrences,
      nextRunOn,
    });
    // O regulă activă care nu mai are scadențe după modificare devine `completed`.
    if (
      current.status === "active" &&
      isFinished(nextRunOn, endOn, current.occurrencesCount, maxOccurrences)
    ) {
      set.status = "completed";
    }
    const row = await updateRuleRow(tx, m.householdId, id, set);
    if (!row) throw new NotFoundError();
    return ruleView(row, today);
  });
}

function addOneDay(date: string): string {
  return addDays(date, 1);
}

export async function pauseRecurringRule(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  ruleId: string,
  today: string = todayLocal(),
): Promise<RecurringRuleView> {
  if (!isValidId(ruleId)) throw new NotFoundError();
  const id = ruleId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await selectRule(tx, m.householdId, id, true);
    if (!current) throw new NotFoundError();
    if (current.status === "completed") {
      throw new ConflictError("recurring_completed", "Regula e completată.");
    }
    const row = await updateRuleRow(tx, m.householdId, id, { status: "paused" });
    return ruleView(row!, today);
  });
}

/**
 * Reluarea de pe pauză NU generează retroactiv lunile sărite: scadența devine prima ≥ max(azi,
 * scadența veche, ultima ocurență + 1 zi). Dacă nu mai există scadențe (după `end_on` sau după
 * rate), regula trece la `completed`.
 */
export async function resumeRecurringRule(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  ruleId: string,
  today: string = todayLocal(),
): Promise<RecurringRuleView> {
  if (!isValidId(ruleId)) throw new NotFoundError();
  const id = ruleId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await selectRule(tx, m.householdId, id, true);
    if (!current) throw new NotFoundError();
    if (current.status === "active") return ruleView(current, today);
    if (current.status === "completed") {
      throw new ConflictError("recurring_completed", "Regula e completată.");
    }
    await requireOpenAccount(tx, m.householdId, current.accountId);
    const last = await lastOccurrenceDate(tx, m.householdId, id);
    const from = [today, current.nextRunOn, last ? addOneDay(last) : current.nextRunOn]
      .sort()
      .at(-1)!;
    const next = occurrenceOnOrAfter(specOf(current), from);
    const finished = isFinished(
      next,
      current.endOn,
      current.occurrencesCount,
      current.maxOccurrences,
    );
    const row = await updateRuleRow(tx, m.householdId, id, {
      status: finished ? "completed" : "active",
      nextRunOn: next ?? current.nextRunOn,
      lastErrorCode: null,
      retryAfter: null,
    });
    return ruleView(row!, today);
  });
}

/**
 * Ștergere definitivă, cu `audit_event` fără sume sau descrieri. Tranzacțiile generate rămân
 * (legătura `recurring_rule_id` devine NULL), ocurențele dispar odată cu regula.
 */
export async function deleteRecurringRule(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  ruleId: string,
): Promise<void> {
  if (!isValidId(ruleId)) throw new NotFoundError();
  const id = ruleId.toLowerCase();
  await inHousehold(deps, actor, householdId, async (tx, m) => {
    if (!(await deleteRuleRow(tx, m.householdId, id))) throw new NotFoundError();
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "recurring_rule.deleted",
      targetType: "recurring_rule",
      targetId: id,
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Generarea
// ---------------------------------------------------------------------------------------------

/**
 * Generează scadențele ≤ `today` ale unei reguli, ca `actor` (membru al gospodăriei): cel mult
 * `MAX_CATCH_UP_PER_RUN` acum (recuperarea limitată), restul la rularea următoare. Totul într-o
 * singură tranzacție SQL. Contul arhivat pune regula pe pauză (`paused_account_archived`), ca să
 * nu fie reîncercată la nesfârșit.
 */
export async function generateDueForRule(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  ruleId: string,
  today: string,
): Promise<GenerateResult> {
  if (!isValidId(ruleId)) throw new NotFoundError();
  const id = ruleId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const rule = await lockRuleForGeneration(tx, m.householdId, id);
    if (!rule) {
      // Inexistentă/invizibilă → 404; blocată de o generare paralelă → nimic de făcut acum.
      if (!(await selectRule(tx, m.householdId, id))) throw new NotFoundError();
      return {
        outcome: "skipped_locked",
        generated: 0,
        status: "active",
        nextRunOn: "",
        remainingDue: true,
      };
    }
    const base = { status: rule.status, nextRunOn: rule.nextRunOn };
    if (rule.status !== "active") {
      return { outcome: "inactive", generated: 0, ...base, remainingDue: false };
    }
    if (rule.nextRunOn > today) {
      return { outcome: "not_due", generated: 0, ...base, remainingDue: false };
    }
    const account = await selectAccount(tx, m.householdId, rule.accountId);
    if (!account || account.archivedAt) {
      const row = await updateRuleRow(tx, m.householdId, id, {
        status: "paused",
        lastErrorCode: "account_archived",
      });
      return {
        outcome: "paused_account_archived",
        generated: 0,
        status: row!.status,
        nextRunOn: row!.nextRunOn,
        remainingDue: false,
      };
    }

    const spec = specOf(rule);
    let next: string | null = rule.nextRunOn;
    let count = rule.occurrencesCount;
    let generated = 0;
    let processed = 0;
    while (
      processed < MAX_CATCH_UP_PER_RUN &&
      next !== null &&
      next <= today &&
      !isFinished(next, rule.endOn, count, rule.maxOccurrences)
    ) {
      const transactionId = randomUUID();
      const claimed = await claimOccurrence(tx, {
        ruleId: rule.id,
        householdId: m.householdId,
        date: next,
        transactionId,
      });
      if (claimed) {
        await insertTransactionRow(tx, {
          id: transactionId,
          householdId: m.householdId,
          accountId: rule.accountId,
          categoryId: rule.categoryId,
          createdByUserId: actor.userId,
          type: rule.type,
          amountMinor: rule.amountMinor,
          currency: rule.currency,
          occurredOn: next,
          description: rule.description,
          merchant: rule.merchant,
          source: "recurring",
          recurringRuleId: rule.id,
        });
        generated += 1;
        count += 1;
      }
      processed += 1;
      next = occurrenceAfter(spec, next);
    }
    if (generated > 0) {
      // Garda 2^53 (ADR 0004/0005) se aplică și tranzacțiilor generate: o depășire anulează lotul.
      await assertAccountsWithinJsonRange(tx, m.householdId, [rule.accountId]);
    }
    const finished = isFinished(next, rule.endOn, count, rule.maxOccurrences);
    const row = await updateRuleRow(tx, m.householdId, id, {
      nextRunOn: next ?? rule.nextRunOn,
      occurrencesCount: count,
      status: finished ? "completed" : "active",
      lastErrorCode: null,
      retryAfter: null,
    });
    return {
      outcome: "generated",
      generated,
      status: row!.status,
      nextRunOn: row!.nextRunOn,
      remainingDue: !finished && next !== null && next <= today,
    };
  });
}

/** Codul (fix, fără detalii) al unei erori de generare. */
export function generationErrorCode(error: unknown): string {
  if (error instanceof MoneyOverflowError) return "amount_out_of_range";
  if (error instanceof NotFoundError) return "not_found";
  if (error instanceof ConflictError) return error.reason;
  return "generation_failed";
}

/**
 * Notează eșecul pe regulă (cod + pauză de reîncercare `RETRY_AFTER_MS`), într-o tranzacție
 * separată de cea anulată: regula iese din fereastra workerului până la reîncercare.
 */
export async function recordGenerationFailure(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  ruleId: string,
  code: string,
  now: Date = new Date(),
): Promise<void> {
  const safe = /^[a-z][a-z0-9_]{1,63}$/.test(code) ? code : "generation_failed";
  await inHousehold(deps, actor, householdId, async (tx, m) => {
    await updateRuleRow(tx, m.householdId, ruleId.toLowerCase(), {
      lastErrorCode: safe,
      retryAfter: new Date(now.getTime() + RETRY_AFTER_MS),
    });
  });
}

export type GenerationSummary = {
  rules: number;
  generated: number;
  failed: number;
  skipped: number;
  /** Coduri de eroare → număr (fără id-uri, fără sume). */
  errors: Record<string, number>;
};

function emptySummary(): GenerationSummary {
  return { rules: 0, generated: 0, failed: 0, skipped: 0, errors: {} };
}

async function generateOne(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  ruleId: string,
  today: string,
  summary: GenerationSummary,
): Promise<void> {
  summary.rules += 1;
  try {
    const r = await generateDueForRule(deps, actor, householdId, ruleId, today);
    summary.generated += r.generated;
    if (r.outcome !== "generated") summary.skipped += 1;
  } catch (error) {
    const code = generationErrorCode(error);
    summary.failed += 1;
    summary.errors[code] = (summary.errors[code] ?? 0) + 1;
    if (code !== "not_found") {
      await recordGenerationFailure(deps, actor, householdId, ruleId, code).catch(() => {});
    }
  }
}

/**
 * „Generează tranzacțiile scadente” pentru o gospodărie (butonul din F5-B și jobul
 * `recurring.generate-now`), ca membrul `actor`. Fiecare regulă în tranzacția ei: o regulă care
 * eșuează nu le oprește pe celelalte.
 */
export async function generateDueForHousehold(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  today: string = todayLocal(),
): Promise<GenerationSummary> {
  const ids = await inHousehold(deps, actor, householdId, (tx, m) =>
    selectDueRuleIds(tx, m.householdId, today),
  );
  const summary = emptySummary();
  for (const id of ids) await generateOne(deps, actor, householdId, id, today, summary);
  return summary;
}

/** Plafonul unei rulări a workerului (aceeași limită maximă ca în funcția SQL). */
export const WORKER_BATCH_LIMIT = 1000;

/**
 * Rularea orară a workerului: scadențele TUTUROR gospodăriilor (doar identificatori, din
 * `due_recurring_rules`), apoi fiecare regulă în contextul gospodăriei ei, ca membrul întors de
 * funcție (creatorul, dacă e încă membru, altfel cel mai vechi proprietar).
 */
export async function runDueRecurring(
  deps: LedgerDeps,
  today: string = todayLocal(),
  limit: number = WORKER_BATCH_LIMIT,
): Promise<GenerationSummary> {
  const due: DueRule[] = await selectDueRules(deps.db, today, limit);
  const summary = emptySummary();
  for (const d of due) {
    await generateOne(deps, { userId: d.actorUserId }, d.householdId, d.ruleId, today, summary);
  }
  return summary;
}
