import "server-only";

import { z } from "zod";

import type { Actor } from "@/lib/authz";
import type { ExportTable, TableCell } from "@/lib/export-table";
import { type Currency, money, toDecimalString } from "@/lib/money";
import {
  type PlanningDeps,
  budgetStatusesIn,
  resolveMonth,
} from "@/modules/budgets/budgets.service";
import { monthSchema } from "@/modules/budgets/budgets.schema";
import { categoryNames } from "@/modules/dashboard/dashboard.service";
import { selectGoals } from "@/modules/goals/goals.repo";
import { goalView } from "@/modules/goals/goals.service";
import { inHousehold } from "@/modules/ledger/context";
import { parseInput } from "@/modules/ledger/input";

import {
  type ExportFormat,
  type ExportOptions,
  type TransactionNames,
  auditExport,
  tagList,
  transactionBatches,
} from "./exports.service";

/**
 * Exporturile tabelare Excel și PDF (Faza 10, F10-C; ADR 0024): aceleași date ca exporturile CSV
 * din Faza 3 (aceeași citire sub RLS, aceleași filtre, același audit fără conținut), dar cu
 * coloane în română, sume cu semn și rânduri de context. Formatul fișierului îl alege apelantul
 * (`xlsx.ts` / `pdf.ts`); aici se construiește doar `ExportTable`.
 *
 * Sumele sunt șiruri zecimale EXACTE (din unități minore bigint). Pe tranzacții, suma are semn:
 * cheltuielile și transferurile de ieșire sunt negative, veniturile și transferurile de intrare
 * pozitive. Fiecare rând păstrează moneda lui (nu se face conversie și nu se însumează monede).
 */

export type TableExportOptions = ExportOptions &
  Readonly<{
    /** Formatul cerut: intră în audit (`metadata.format`). */
    format: Exclude<ExportFormat, "csv">;
  }>;

const TYPE_LABEL = {
  expense: "Cheltuială",
  income: "Venit",
  transfer_out: "Transfer (ieșire)",
  transfer_in: "Transfer (intrare)",
} as const;

const dayOf = (now: () => Date): string => now().toISOString().slice(0, 10);

function amount(minor: bigint, currency: Currency, negative: boolean): string {
  return toDecimalString(money(negative ? -minor : minor, currency));
}

/** Perioada și numărul de rânduri, ca rânduri de context. */
function context(deps: PlanningDeps, rows: number, extra: readonly string[] = []): string[] {
  const now = deps.now ?? (() => new Date());
  return [...extra, `Generat la ${dayOf(now)}`, `Rânduri: ${rows}`];
}

/** Tranzacțiile (filtrele listei, cronologic), pentru Excel sau PDF. */
export async function exportTransactionsTable(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  rawQuery: unknown,
  options: TableExportOptions,
): Promise<ExportTable> {
  const rows: TableCell[][] = [];
  let names: TransactionNames | null = null;
  let total = 0;
  for await (const batch of transactionBatches(
    deps,
    actor,
    householdId,
    rawQuery,
    options,
    options.format,
  )) {
    if (batch.kind === "start") {
      names = batch.names;
      total = batch.total;
      continue;
    }
    for (const r of batch.rows) {
      const kind =
        r.type === "transfer"
          ? r.transferDirection === "in"
            ? "transfer_in"
            : "transfer_out"
          : r.type;
      const negative = kind === "expense" || kind === "transfer_out";
      const tags = tagList(names!, batch.tagIds.get(r.id));
      rows.push([
        r.occurredOn,
        TYPE_LABEL[kind],
        names!.accounts.get(r.accountId) ?? null,
        r.categoryId ? (names!.categories.get(r.categoryId) ?? null) : null,
        tags === "" ? null : tags.replaceAll("|", ", "),
        r.merchant,
        r.description,
        amount(r.amountMinor, r.currency, negative),
        r.currency,
        r.notes,
      ]);
    }
  }
  return {
    title: "Tranzacții",
    context: context(deps, total),
    columns: [
      { key: "occurred_on", label: "Data", kind: "date" },
      { key: "type", label: "Tip", kind: "text" },
      { key: "account", label: "Cont", kind: "text" },
      { key: "category", label: "Categorie", kind: "text" },
      { key: "tags", label: "Etichete", kind: "text" },
      { key: "merchant", label: "Comerciant", kind: "text" },
      { key: "description", label: "Descriere", kind: "text" },
      { key: "amount", label: "Suma", kind: "money" },
      { key: "currency", label: "Moneda", kind: "text" },
      { key: "notes", label: "Note", kind: "text" },
    ],
    rows,
  };
}

const GOAL_STATUS_LABEL = { active: "Activ", achieved: "Atins", abandoned: "Abandonat" } as const;

/** Obiectivele gospodăriei (toate stările). */
export async function exportGoalsTable(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  options: TableExportOptions,
): Promise<ExportTable> {
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const goals = (await selectGoals(tx, m.householdId)).map(goalView);
    await auditExport(tx, actor, m.householdId, "goals", goals.length, options.format);
    return {
      title: "Obiective",
      context: context(deps, goals.length),
      columns: [
        { key: "name", label: "Obiectiv", kind: "text" },
        { key: "status", label: "Stare", kind: "text" },
        { key: "currency", label: "Moneda", kind: "text" },
        { key: "target", label: "Țintă", kind: "money" },
        { key: "saved", label: "Economisit", kind: "money" },
        { key: "progress", label: "Progres (%)", kind: "percent" },
        { key: "deadline", label: "Termen", kind: "date" },
      ],
      rows: goals.map((g) => [
        g.name,
        GOAL_STATUS_LABEL[g.status],
        g.currency,
        amount(g.targetMinor, g.currency, false),
        amount(g.savedMinor, g.currency, false),
        g.progressPct,
        g.deadline,
      ]),
    };
  });
}

const BUDGET_STATUS_LABEL = {
  green: "În limită",
  yellow: "Aproape de limită",
  red: "Depășit",
} as const;
const BUDGET_SCOPE_LABEL = { household: "Gospodărie", personal: "Personal" } as const;

const budgetQuerySchema = z.strictObject({ month: monthSchema.optional() }).optional();

/** Bugetele active vizibile actorului, cu starea lor într-o lună (implicit cea curentă). */
export async function exportBudgetsTable(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  rawQuery: unknown,
  options: TableExportOptions,
): Promise<ExportTable> {
  const query = parseInput(budgetQuerySchema, rawQuery) ?? {};
  const now = deps.now ?? (() => new Date());
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const month = await resolveMonth(tx, m.householdId, query.month, now);
    const names = await categoryNames(tx, m.householdId);
    const statuses = await budgetStatusesIn(tx, m.householdId, actor.userId, month);
    await auditExport(tx, actor, m.householdId, "budgets", statuses.length, options.format);
    return {
      title: "Bugete",
      context: context(deps, statuses.length, [`Luna: ${month}`]),
      columns: [
        { key: "scope", label: "Domeniu", kind: "text" },
        { key: "category", label: "Categorie", kind: "text" },
        { key: "currency", label: "Moneda", kind: "text" },
        { key: "amount", label: "Buget", kind: "money" },
        { key: "spent", label: "Cheltuit", kind: "money" },
        { key: "remaining", label: "Rămas", kind: "money" },
        { key: "percent", label: "Utilizat (%)", kind: "percent" },
        { key: "status", label: "Stare", kind: "text" },
      ],
      rows: statuses.map((b) => [
        BUDGET_SCOPE_LABEL[b.scope],
        b.categoryId ? (names.get(b.categoryId) ?? null) : "Toate categoriile",
        b.currency,
        amount(b.amountMinor, b.currency, false),
        amount(b.spentMinor, b.currency, false),
        amount(b.remainingMinor, b.currency, false),
        b.percent,
        BUDGET_STATUS_LABEL[b.status],
      ]),
    };
  });
}
