import "server-only";

import type { Tx } from "@/db";
import { pgErrorInfo } from "@/db/pg-errors";
import { REPORT_DEFINITIONS_PER_HOUSEHOLD_MAX } from "@/db/schema";
import { type Actor, ForbiddenError, NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { periodRange } from "@/lib/periods";
import { insertAudit } from "@/modules/auth/audit";
import { selectCategory } from "@/modules/categories/categories.repo";
import {
  csvHeader,
  csvRow,
  decimal,
  raw,
  text,
  CSV_BOM,
  type CsvDialect,
} from "@/modules/exports/csv";
import { type LedgerDeps, inHousehold } from "@/modules/ledger/context";
import { isValidId, parseInput } from "@/modules/ledger/input";
import { money } from "@/lib/money";
import { type PricesDeps, guardScan, householdToday } from "@/modules/prices/prices.service";
import {
  type DateWindow,
  selectCandidateLines,
  selectCoverage,
} from "@/modules/prices/prices.repo";
import { selectTag } from "@/modules/tags/tags.repo";

import {
  DEFAULT_REPORT_PERIOD,
  type ReportDefinitionView,
  type RunResult,
  reportCreateSchema,
  reportExportQuerySchema,
  reportListQuerySchema,
  reportPreviewSchema,
  reportRunQuerySchema,
  reportUpdateSchema,
} from "./report-definitions.schema";
import {
  deleteDefinition,
  insertDefinition,
  selectDefinition,
  selectDefinitions,
  updateDefinition,
} from "./report-definitions.repo";
import { type ReportRules, canonicalRules } from "./rules";
import { type RunLine, matchLines, runReport } from "./run";

/**
 * Serviciile rapoartelor de micro-cheltuieli (Faza 10, F10-B; ADR 0023): CRUD pe definițiile
 * gospodăriei (cele de sistem sunt doar citibile), rularea, previzualizarea și exportul CSV.
 * Totul în tranzacția membrului (RLS + gospodăria din sesiune); erori cu cod fix, fără ecou din
 * numele raportului sau din regulile primite; nimic din conținut (nume, reguli, produse) nu intră
 * în audit. Regulile nu ajung niciodată în SQL: interogarea aduce liniile după tip/categorie/
 * etichetă, iar potrivirea pe nume rulează în cod (`rules.ts`).
 */

export type ReportsDeps = PricesDeps;

const readonlySystem = () => new ForbiddenError();

/** Traduce conflictele de nume și plafonul (cod fix, fără valori). */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ConflictError && error.reason === "duplicate") {
      throw new ConflictError("report_name_taken", "Există deja un raport activ cu acest nume.");
    }
    const info = pgErrorInfo(error);
    if (info?.code === "54000" && info.constraint === "report_definitions_cap") {
      throw new ConflictError(
        "report_limit",
        `Poți avea cel mult ${REPORT_DEFINITIONS_PER_HOUSEHOLD_MAX} de rapoarte proprii.`,
      );
    }
    throw error;
  }
}

/** Categoriile și etichetele din reguli trebuie să existe (vizibile gospodăriei). */
async function assertRefs(tx: Tx, householdId: string, rules: ReportRules): Promise<void> {
  for (const id of rules.categoryIds) {
    if (!(await selectCategory(tx, householdId, id))) {
      throw new ValidationError({ "rules.categoryIds": "Categorie inexistentă." });
    }
  }
  for (const id of rules.tagIds) {
    if (!(await selectTag(tx, householdId, id))) {
      throw new ValidationError({ "rules.tagIds": "Etichetă inexistentă." });
    }
  }
}

// --- CRUD ---------------------------------------------------------------------------------------

export async function listDefinitions(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  rawQuery: unknown = {},
): Promise<ReportDefinitionView[]> {
  const q = parseInput(reportListQuerySchema, rawQuery) ?? {};
  return inHousehold(deps, actor, householdId, (tx, m) =>
    selectDefinitions(tx, m.householdId, q.includeArchived === true),
  );
}

export async function getDefinition(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  id: string,
): Promise<ReportDefinitionView> {
  if (!isValidId(id)) throw new NotFoundError();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const d = await selectDefinition(tx, m.householdId, id.toLowerCase());
    if (!d) throw new NotFoundError();
    return d;
  });
}

export async function createDefinition(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown,
): Promise<ReportDefinitionView> {
  const input = parseInput(reportCreateSchema, rawInput);
  return guarded(() =>
    inHousehold(deps, actor, householdId, async (tx, m) => {
      await assertRefs(tx, m.householdId, input.rules);
      const created = await insertDefinition(tx, {
        householdId: m.householdId,
        createdByUserId: actor.userId,
        name: input.name,
        description: input.description ?? null,
        advice: input.advice ?? null,
        rules: canonicalRules(input.rules),
      });
      await insertAudit(tx, actor.userId, m.householdId, {
        action: "report.created",
        targetType: "report_definition",
        targetId: created.id,
      });
      return created;
    }),
  );
}

export async function updateReportDefinition(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  id: string,
  rawInput: unknown,
): Promise<ReportDefinitionView> {
  if (!isValidId(id)) throw new NotFoundError();
  const input = parseInput(reportUpdateSchema, rawInput);
  return guarded(() =>
    inHousehold(deps, actor, householdId, async (tx, m) => {
      const current = await selectDefinition(tx, m.householdId, id.toLowerCase());
      if (!current) throw new NotFoundError();
      if (current.isSystem) throw readonlySystem();
      if (input.rules) await assertRefs(tx, m.householdId, input.rules);
      const updated = await updateDefinition(tx, m.householdId, current.id, {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.advice === undefined ? {} : { advice: input.advice }),
        ...(input.rules === undefined ? {} : { rules: canonicalRules(input.rules) }),
        ...(input.archived === undefined ? {} : { archived: input.archived }),
      });
      if (!updated) throw new NotFoundError();
      await insertAudit(tx, actor.userId, m.householdId, {
        action: "report.updated",
        targetType: "report_definition",
        targetId: updated.id,
      });
      return updated;
    }),
  );
}

export async function removeDefinition(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  id: string,
): Promise<void> {
  if (!isValidId(id)) throw new NotFoundError();
  await inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await selectDefinition(tx, m.householdId, id.toLowerCase());
    if (!current) throw new NotFoundError();
    if (current.isSystem) throw readonlySystem();
    if (!(await deleteDefinition(tx, m.householdId, current.id))) throw new NotFoundError();
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "report.deleted",
      targetType: "report_definition",
      targetId: current.id,
    });
  });
}

// --- Rularea, previzualizarea, exportul --------------------------------------------------------

type Executed = Readonly<{
  window: DateWindow;
  candidates: RunLine[];
  coverage: Awaited<ReturnType<typeof selectCoverage>>;
}>;

async function load(
  tx: Tx,
  householdId: string,
  rules: ReportRules,
  window: DateWindow,
): Promise<Executed> {
  const candidates = await selectCandidateLines(
    tx,
    householdId,
    { kinds: rules.kinds, categoryIds: rules.categoryIds, tagIds: rules.tagIds },
    window,
  );
  const coverage = await selectCoverage(tx, householdId, window);
  return { window, candidates, coverage };
}

async function execute(
  deps: ReportsDeps,
  actor: Actor,
  householdId: string,
  source: { id: string } | { rules: ReportRules },
  rawPeriod: unknown,
): Promise<RunResult> {
  const q = parseInput(reportRunQuerySchema, rawPeriod) ?? {};
  const period = q.period ?? DEFAULT_REPORT_PERIOD;
  return guardScan(() =>
    inHousehold(deps, actor, householdId, async (tx, m) => {
      let definition: ReportDefinitionView | null = null;
      let rules: ReportRules;
      if ("id" in source) {
        definition = await selectDefinition(tx, m.householdId, source.id);
        if (!definition) throw new NotFoundError();
        rules = definition.rules;
      } else {
        rules = source.rules;
      }
      const today = await householdToday(deps, tx, m.householdId);
      const range = periodRange(period, today);
      const { candidates, coverage } = await load(tx, m.householdId, rules, range);
      const run = runReport(rules, candidates, coverage);
      return { definition, period, from: range.from, to: range.to, run, coverage };
    }),
  );
}

/** Rulează un raport (de sistem sau propriu) pe o perioadă. */
export async function runDefinition(
  deps: ReportsDeps,
  actor: Actor,
  householdId: string,
  id: string,
  rawQuery: unknown = {},
): Promise<RunResult> {
  if (!isValidId(id)) throw new NotFoundError();
  return execute(deps, actor, householdId, { id: id.toLowerCase() }, rawQuery);
}

/** Previzualizare: reguli primite în corp, nimic salvat (aceeași rulare, aceleași limite). */
export async function previewRules(
  deps: ReportsDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown,
): Promise<RunResult> {
  const input = parseInput(reportPreviewSchema, rawInput);
  await inHousehold(deps, actor, householdId, (tx, m) =>
    assertRefs(tx, m.householdId, input.rules),
  );
  return execute(
    deps,
    actor,
    householdId,
    { rules: canonicalRules(input.rules) },
    {
      period: input.period,
    },
  );
}

export const REPORT_CSV_COLUMNS = [
  "line_id",
  "receipt_id",
  "occurred_on",
  "merchant",
  "name",
  "kind",
  "quantity",
  "currency",
  "line_total_minor",
  "line_total",
] as const;

export type ReportCsv = Readonly<{ csv: string; rows: number }>;

/**
 * Exportul CSV al liniilor potrivite (TOATE, nu doar istoricul de 200 din ecran), cu protecția de
 * formule a `csv.ts` pe textul liber (comerciant, nume de produs). Auditat fără conținut (doar
 * tipul și numărul de rânduri). Reducerile apar cu suma pozitivă și `kind = discount`, ca pe bon.
 */
export async function exportDefinitionCsv(
  deps: ReportsDeps,
  actor: Actor,
  householdId: string,
  id: string,
  rawQuery: unknown = {},
  options: Readonly<{ dialect?: CsvDialect }> = {},
): Promise<ReportCsv> {
  if (!isValidId(id)) throw new NotFoundError();
  const q = parseInput(reportExportQuerySchema, rawQuery) ?? {};
  const period = q.period ?? DEFAULT_REPORT_PERIOD;
  const dialect = options.dialect ?? "rfc4180";
  return guardScan(() =>
    inHousehold(deps, actor, householdId, async (tx, m) => {
      const definition = await selectDefinition(tx, m.householdId, id.toLowerCase());
      if (!definition) throw new NotFoundError();
      const today = await householdToday(deps, tx, m.householdId);
      const range = periodRange(period, today);
      const { candidates } = await load(tx, m.householdId, definition.rules, range);
      const lines = matchLines(definition.rules, candidates).sort((a, b) =>
        a.occurredOn !== b.occurredOn
          ? a.occurredOn < b.occurredOn
            ? -1
            : 1
          : a.id.localeCompare(b.id),
      );
      const out = [CSV_BOM + csvHeader(REPORT_CSV_COLUMNS, dialect)];
      for (const l of lines) {
        out.push(
          csvRow(
            [
              raw(l.id),
              raw(l.receiptId),
              raw(l.occurredOn),
              text(l.merchantName),
              text(l.rawName),
              raw(l.kind),
              raw(l.quantity),
              raw(l.currency),
              raw(l.lineTotalMinor),
              decimal(money(l.lineTotalMinor, l.currency), dialect),
            ],
            dialect,
          ),
        );
      }
      await insertAudit(tx, actor.userId, m.householdId, {
        action: "export.downloaded",
        metadata: { kind: "report", rows: lines.length },
      });
      return { csv: out.join(""), rows: lines.length };
    }),
  );
}
