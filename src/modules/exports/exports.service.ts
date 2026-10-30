import "server-only";

import { z } from "zod";

import type { Tx } from "@/db";
import type { Actor } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { money } from "@/lib/money";
import { insertAudit } from "@/modules/auth/audit";
import { selectAccounts } from "@/modules/accounts/accounts.repo";
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
import { selectTagIdsOf, selectTags } from "@/modules/tags/tags.repo";
import { countTransactions, selectTransactionPage } from "@/modules/transactions/transactions.repo";
import { type Cursor, transactionListSchema } from "@/modules/transactions/transactions.schema";
import { listFiltersOf } from "@/modules/transactions/transactions.service";

import {
  CSV_BOM,
  CSV_DIALECTS,
  type CsvDialect,
  csvHeader,
  csvRow,
  decimal,
  raw,
  text,
} from "./csv";

/**
 * Exporturile CSV (Faza 3; ADR 0007): tranzacții (cu filtrele listei), obiective, bugete.
 * Izolate pe gospodărie (`withMember` + RLS + filtru explicit), coduri de coloană stabile,
 * `*_minor` (întreg) + `currency` + suma zecimală exactă (`money.ts`), date ISO, UTF-8 cu BOM.
 *
 * Tranzacțiile: cel mult `MAX_EXPORT_ROWS` rânduri. Se numără ÎNTÂI (peste plafon → 409
 * `export_too_large`, fără conținut parțial), apoi se generează pe pagini de cursor (cheie
 * `(occurred_on, id)`, crescător), câte o tranzacție SQL pe pagină: memoria rămâne mică, iar
 * apelantul (API-ul, F3-B) poate trimite fragmentele pe măsură ce vin. Un export lung nu e un
 * instantaneu: rândurile adăugate în timpul lui pot apărea sau nu (plafonul rămâne garantat).
 *
 * Fiecare export acceptat se auditează (`export.downloaded`, F3-B) fără conținut: doar tipul
 * exportului și numărul de rânduri (pentru tranzacții, numărul din numărare).
 */

export type ExportKindName = "transactions" | "goals" | "budgets" | "receipts" | "accounting";
export type ExportFormat = "csv" | "xlsx" | "pdf";

export async function auditExport(
  tx: Tx,
  actor: Actor,
  householdId: string,
  kind: ExportKindName,
  rows: number,
  format: ExportFormat = "csv",
): Promise<void> {
  await insertAudit(tx, actor.userId, householdId, {
    action: "export.downloaded",
    // CSV păstrează forma din Faza 3 (`kind` + `rows`); celelalte formate adaugă `format`.
    metadata: format === "csv" ? { kind, rows } : { kind, rows, format },
  });
}

export const MAX_EXPORT_ROWS = 50_000;
export const EXPORT_PAGE_SIZE = 1_000;

export type ExportOptions = Readonly<{
  dialect?: CsvDialect;
  /** Doar pentru teste: plafonul și pagina mai mici. */
  maxRows?: number;
  pageSize?: number;
}>;

const dialectSchema = z.enum(CSV_DIALECTS).optional();

export const TRANSACTION_COLUMNS = [
  "id",
  "occurred_on",
  "type",
  "transfer_direction",
  "account_id",
  "account_name",
  "category_id",
  "category_name",
  "tags",
  "amount_minor",
  "currency",
  "amount",
  "merchant",
  "description",
  "notes",
  "source",
  "transfer_group_id",
  "created_at",
] as const;

export const GOAL_COLUMNS = [
  "id",
  "name",
  "status",
  "currency",
  "target_minor",
  "target",
  "saved_minor",
  "saved",
  "progress_pct",
  "deadline",
  "account_id",
  "created_at",
] as const;

export const BUDGET_COLUMNS = [
  "id",
  "month",
  "scope",
  "category_id",
  "category_name",
  "currency",
  "amount_minor",
  "amount",
  "warn_pct",
  "spent_minor",
  "spent",
  "remaining_minor",
  "remaining",
  "percent",
  "status",
] as const;

export function dialectOf(options: ExportOptions): CsvDialect {
  const parsed = dialectSchema.safeParse(options.dialect);
  if (!parsed.success) throw new ValidationError({ dialect: "Dialect CSV necunoscut." });
  return parsed.data ?? "rfc4180";
}

type TransactionRow = Awaited<ReturnType<typeof selectTransactionPage>>[number];
export type TransactionNames = Readonly<{
  accounts: ReadonlyMap<string, string>;
  categories: ReadonlyMap<string, string>;
  tags: ReadonlyMap<string, string>;
}>;
export type TransactionBatch =
  | Readonly<{ kind: "start"; total: number; names: TransactionNames }>
  | Readonly<{
      kind: "page";
      rows: readonly TransactionRow[];
      tagIds: ReadonlyMap<string, readonly string[]>;
    }>;

/**
 * Citirea comună a tranzacțiilor pentru toate formatele: primul pas (validare, numărare, plafon,
 * audit, nume) iese ca `start`, apoi paginile de cursor. `maxRows` și formatul vin de la apelant.
 */
export async function* transactionBatches(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  rawQuery: unknown,
  options: ExportOptions,
  format: ExportFormat,
): AsyncGenerator<TransactionBatch, void, undefined> {
  const query = parseInput(transactionListSchema, rawQuery) ?? {};
  if (query.cursor !== undefined || query.limit !== undefined || query.sort !== undefined) {
    throw new ValidationError({ _: "Exportul nu acceptă cursor, limit sau sort." });
  }
  const maxRows = options.maxRows ?? MAX_EXPORT_ROWS;
  const pageSize = options.pageSize ?? EXPORT_PAGE_SIZE;
  const filters = listFiltersOf(query);

  // Numărarea, apartenența și numele (conturi, categorii, etichete) într-o primă tranzacție.
  const names = await inHousehold(deps, actor, householdId, async (tx, m) => {
    const total = await countTransactions(tx, m.householdId, filters);
    if (total > maxRows) {
      throw new ConflictError(
        "export_too_large",
        `Exportul are peste ${maxRows} de rânduri; restrânge filtrele (de exemplu intervalul).`,
      );
    }
    await auditExport(tx, actor, m.householdId, "transactions", total, format);
    const accountNames = new Map(
      (await selectAccounts(tx, m.householdId, { includeArchived: true })).map((a) => [
        a.id,
        a.name,
      ]),
    );
    const tagNames = new Map((await selectTags(tx, m.householdId)).map((t) => [t.id, t.name]));
    return {
      total,
      names: {
        accounts: accountNames,
        categories: await categoryNames(tx, m.householdId),
        tags: tagNames,
      },
    };
  });
  yield { kind: "start", total: names.total, names: names.names };

  let cursor: Cursor | null = null;
  let written = 0;
  while (written < maxRows) {
    const limit = Math.min(pageSize, maxRows - written);
    const page = await inHousehold(deps, actor, householdId, async (tx, m) => {
      const rows = await selectTransactionPage(
        tx,
        m.householdId,
        filters,
        "date_asc",
        cursor,
        limit,
      );
      const slice = rows.slice(0, limit);
      const tagIds = await selectTagIdsOf(
        tx,
        m.householdId,
        slice.map((r) => r.id),
      );
      return { rows: slice, more: rows.length > limit, tagIds };
    });
    if (page.rows.length === 0) break;
    yield { kind: "page", rows: page.rows, tagIds: page.tagIds };
    written += page.rows.length;
    if (!page.more) break;
    const last = page.rows[page.rows.length - 1]!;
    cursor = { sort: "date_asc", key: last.occurredOn, id: last.id };
  }
}

export function tagList(names: TransactionNames, ids: readonly string[] | undefined): string {
  return (ids ?? [])
    .map((id) => names.tags.get(id) ?? "")
    .filter((n) => n !== "")
    .sort((a, b) => a.localeCompare(b, "ro"))
    .join("|");
}

/**
 * Exportul tranzacțiilor, ca fragmente de text (primul: BOM + antet). Filtrele sunt cele ale listei
 * (`transactionListSchema`), fără `cursor`, `limit` și `sort` (ordinea e fixă: cronologic).
 */
export async function* exportTransactionsCsv(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  rawQuery: unknown = {},
  options: ExportOptions = {},
): AsyncGenerator<string, void, undefined> {
  const dialect = dialectOf(options);
  let names: TransactionNames | null = null;
  for await (const batch of transactionBatches(
    deps,
    actor,
    householdId,
    rawQuery,
    options,
    "csv",
  )) {
    if (batch.kind === "start") {
      names = batch.names;
      yield CSV_BOM + csvHeader(TRANSACTION_COLUMNS, dialect);
      continue;
    }
    let chunk = "";
    for (const r of batch.rows) {
      const tags = tagList(names!, batch.tagIds.get(r.id));
      chunk += csvRow(
        [
          raw(r.id),
          raw(r.occurredOn),
          raw(r.type),
          raw(r.transferDirection),
          raw(r.accountId),
          text(names!.accounts.get(r.accountId) ?? null),
          raw(r.categoryId),
          text(r.categoryId ? (names!.categories.get(r.categoryId) ?? null) : null),
          text(tags === "" ? null : tags),
          raw(r.amountMinor),
          raw(r.currency),
          decimal(money(r.amountMinor, r.currency), dialect),
          text(r.merchant),
          text(r.description),
          text(r.notes),
          raw(r.source),
          raw(r.transferGroupId),
          raw(r.createdAt.toISOString()),
        ],
        dialect,
      );
    }
    yield chunk;
  }
}

/** Tot exportul tranzacțiilor într-un singur șir (teste și exporturi mici). */
export async function collectCsv(chunks: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const c of chunks) out += c;
  return out;
}

/** Exportul obiectivelor gospodăriei (toate stările). */
export async function exportGoalsCsv(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  options: ExportOptions = {},
): Promise<string> {
  const dialect = dialectOf(options);
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    let out = CSV_BOM + csvHeader(GOAL_COLUMNS, dialect);
    const goals = (await selectGoals(tx, m.householdId)).map(goalView);
    await auditExport(tx, actor, m.householdId, "goals", goals.length);
    for (const g of goals) {
      out += csvRow(
        [
          raw(g.id),
          text(g.name),
          raw(g.status),
          raw(g.currency),
          raw(g.targetMinor),
          decimal(money(g.targetMinor, g.currency), dialect),
          raw(g.savedMinor),
          decimal(money(g.savedMinor, g.currency), dialect),
          raw(g.progressPct),
          raw(g.deadline),
          raw(g.accountId),
          raw(g.createdAt.toISOString()),
        ],
        dialect,
      );
    }
    return out;
  });
}

const budgetExportQuerySchema = z.strictObject({ month: monthSchema.optional() }).optional();

/** Exportul bugetelor active vizibile actorului, cu starea lor într-o lună (implicit cea curentă). */
export async function exportBudgetsCsv(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  rawQuery: unknown = {},
  options: ExportOptions = {},
): Promise<string> {
  const query = parseInput(budgetExportQuerySchema, rawQuery) ?? {};
  const dialect = dialectOf(options);
  const now = deps.now ?? (() => new Date());
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const month = await resolveMonth(tx, m.householdId, query.month, now);
    const names = await categoryNames(tx, m.householdId);
    let out = CSV_BOM + csvHeader(BUDGET_COLUMNS, dialect);
    const statuses = await budgetStatusesIn(tx, m.householdId, actor.userId, month);
    await auditExport(tx, actor, m.householdId, "budgets", statuses.length);
    for (const b of statuses) {
      out += csvRow(
        [
          raw(b.id),
          raw(b.month),
          raw(b.scope),
          raw(b.categoryId),
          text(b.categoryId ? (names.get(b.categoryId) ?? null) : null),
          raw(b.currency),
          raw(b.amountMinor),
          decimal(money(b.amountMinor, b.currency), dialect),
          raw(b.warnPct),
          raw(b.spentMinor),
          decimal(money(b.spentMinor, b.currency), dialect),
          raw(b.remainingMinor),
          decimal(money(b.remainingMinor, b.currency), dialect),
          raw(b.percent),
          raw(b.status),
        ],
        dialect,
      );
    }
    return out;
  });
}
