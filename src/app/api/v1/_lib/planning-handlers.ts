import "server-only";

import type { DbOrTx } from "@/db";
import { type Month, addMonths, isMonth } from "@/lib/calendar";
import { ValidationError } from "@/lib/errors";
import { budgetStatusToJson, budgetToJson } from "@/modules/budgets/budgets.schema";
import {
  type PlanningDeps,
  createBudget,
  deleteBudget,
  getBudget,
  getBudgetStatuses,
  listBudgets,
  resolveMonth,
  updateBudget,
} from "@/modules/budgets/budgets.service";
import { dashboardToJson } from "@/modules/dashboard/dashboard.schema";
import type { CsvDialect } from "@/modules/exports/csv";
import { getDashboard } from "@/modules/dashboard/dashboard.service";
import {
  exportBudgetsCsv,
  exportGoalsCsv,
  exportTransactionsCsv,
  MAX_EXPORT_ROWS,
} from "@/modules/exports/exports.service";
import { exportAccountingTable } from "@/modules/exports/accounting.service";
import { dialectOf } from "@/modules/exports/exports.service";
import { tableToCsv } from "@/modules/exports/table-csv";
import {
  exportBudgetsTable,
  exportGoalsTable,
  exportTransactionsTable,
} from "@/modules/exports/tables.service";
import { PDF_CONTENT_TYPE, PDF_MAX_ROWS, tableToPdf } from "@/lib/pdf";
import { XLSX_CONTENT_TYPE, tableToXlsx } from "@/lib/xlsx";
import { goalToJson } from "@/modules/goals/goals.schema";
import {
  contributeToGoal,
  createGoal,
  deleteGoal,
  getGoal,
  listGoals,
  updateGoal,
} from "@/modules/goals/goals.service";
import { inHousehold } from "@/modules/ledger/context";
import { monthlyReportToJson } from "@/modules/reports/reports.schema";
import { getMonthlyReport } from "@/modules/reports/reports.service";
import { tagToJson } from "@/modules/tags/tags.schema";
import { createTag, deleteTag, getTag, listTags, updateTag } from "@/modules/tags/tags.service";

import {
  type ApiContext,
  type ApiDeps,
  ApiError,
  currentHousehold,
  enforceRateLimit,
  handle,
  idempotencyKeyOf,
  idempotentCreate,
  json,
  readJsonBody,
  readOptionalJsonBody,
  readQuery,
  routeId,
} from "./http";
import { TRANSACTION_FILTER_QUERY, transactionQueryOf } from "./ledger-handlers";

/**
 * Handlerele planificării și raportării (Faza 3, ADR 0007): etichete, bugete, obiective,
 * dashboard, raportul lunar și exporturile CSV. Aceleași reguli ca registrul (ADR 0005): sesiune,
 * gospodăria din sesiune/bază, Zod strict în servicii, 404 uniform, `Idempotency-Key` pe crearea
 * resurselor, rate limiting pe mutații (și separat, mai strâns, pe exporturi).
 */

const noBody = () => json(null, 204);

/** Dependențele serviciilor de planificare: baza dată și ceasul CERERII (testabil). */
const planning = (db: DbOrTx, ctx: ApiContext): PlanningDeps => ({
  db,
  now: () => new Date(ctx.now),
});

// --- Luna (`?month=YYYY-MM`) -----------------------------------------------------------------

/**
 * Câte luni în urmă se acceptă față de luna curentă (decizia mea): 60, adică aceeași lună de
 * acum 5 ani. Luni viitoare nu se acceptă (luna curentă + 0). Luna curentă e cea din fusul orar
 * al gospodăriei (implicit `Europe/Bucharest`), cu ceasul cererii, exact ca în servicii.
 */
export const MONTH_WINDOW_BACK = 60;

/**
 * Luna cerută (validată strict: format și interval) sau luna curentă a gospodăriei. Se trimite
 * explicit serviciului, deci luna din răspuns e mereu cea validată aici.
 */
async function monthOf(ctx: ApiContext, householdId: string, raw: unknown): Promise<Month> {
  const current = await inHousehold({ db: ctx.deps.db }, ctx.actor, householdId, (tx, m) =>
    resolveMonth(tx, m.householdId, undefined, () => new Date(ctx.now)),
  );
  if (raw === undefined) return current;
  if (!isMonth(raw)) {
    throw new ValidationError({ month: "Luna trebuie să fie de forma AAAA-LL." });
  }
  if (raw > current || raw < addMonths(current, -MONTH_WINDOW_BACK)) {
    throw new ValidationError({
      month: `Luna trebuie să fie între ultimele ${MONTH_WINDOW_BACK} de luni și luna curentă.`,
    });
  }
  return raw;
}

// --- Etichetele ------------------------------------------------------------------------------

export function listTagsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { includeHidden: "bool" });
    const hh = await currentHousehold(ctx);
    const list = await listTags({ db: d.db }, ctx.actor, hh, query);
    return json({ data: list.map(tagToJson) });
  });
}

export function createTagHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    return idempotentCreate(ctx, hh, body, async (db) => ({
      status: 201,
      body: { data: tagToJson(await createTag({ db }, ctx.actor, hh, body)) },
    }));
  });
}

export function getTagHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const hh = await currentHousehold(ctx);
    return json({ data: tagToJson(await getTag({ db: d.db }, ctx.actor, hh, routeId(id))) });
  });
}

export function patchTagHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const tagId = routeId(id);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    return json({ data: tagToJson(await updateTag({ db: d.db }, ctx.actor, hh, tagId, body)) });
  });
}

export function deleteTagHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const tagId = routeId(id);
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    await deleteTag({ db: d.db }, ctx.actor, hh, tagId);
    return noBody();
  });
}

// --- Bugetele --------------------------------------------------------------------------------

export function listBudgetsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { includeArchived: "bool" });
    const hh = await currentHousehold(ctx);
    const list = await listBudgets(planning(d.db, ctx), ctx.actor, hh, query);
    return json({ data: list.map(budgetToJson) });
  });
}

export function createBudgetHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    return idempotentCreate(ctx, hh, body, async (db) => ({
      status: 201,
      body: { data: budgetToJson(await createBudget(planning(db, ctx), ctx.actor, hh, body)) },
    }));
  });
}

export function getBudgetHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const hh = await currentHousehold(ctx);
    const view = await getBudget(planning(d.db, ctx), ctx.actor, hh, routeId(id));
    return json({ data: budgetToJson(view) });
  });
}

export function patchBudgetHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const budgetId = routeId(id);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    const view = await updateBudget(planning(d.db, ctx), ctx.actor, hh, budgetId, body);
    return json({ data: budgetToJson(view) });
  });
}

export function deleteBudgetHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const budgetId = routeId(id);
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    await deleteBudget(planning(d.db, ctx), ctx.actor, hh, budgetId);
    return noBody();
  });
}

/**
 * Starea bugetelor într-o lună: semaforul, `spentMinor`, `percent`, `remainingMinor`, plus
 * `alerts` = avertizările (bugetele galbene și roșii, roșii întâi).
 */
export function budgetStatusHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { month: "string" });
    const hh = await currentHousehold(ctx);
    const month = await monthOf(ctx, hh, query.month);
    const list = await getBudgetStatuses(planning(d.db, ctx), ctx.actor, hh, { month });
    const rank = (s: (typeof list)[number]) => (s.status === "red" ? 0 : 1);
    const alerts = list
      .filter((s) => s.status !== "green")
      .sort((a, b) => rank(a) - rank(b))
      .map((s) => ({ budgetId: s.id, status: s.status }));
    return json({ month, data: list.map(budgetStatusToJson), alerts });
  });
}

// --- Obiectivele -----------------------------------------------------------------------------

export function listGoalsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { status: "string" });
    const hh = await currentHousehold(ctx);
    const list = await listGoals({ db: d.db }, ctx.actor, hh, query);
    return json({ data: list.map(goalToJson) });
  });
}

export function createGoalHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    return idempotentCreate(ctx, hh, body, async (db) => ({
      status: 201,
      body: { data: goalToJson(await createGoal({ db }, ctx.actor, hh, body)) },
    }));
  });
}

export function getGoalHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const hh = await currentHousehold(ctx);
    return json({ data: goalToJson(await getGoal({ db: d.db }, ctx.actor, hh, routeId(id))) });
  });
}

export function patchGoalHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const goalId = routeId(id);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    return json({ data: goalToJson(await updateGoal({ db: d.db }, ctx.actor, hh, goalId, body)) });
  });
}

/**
 * Ștergerea definitivă a obiectivului (auditată fără sume). Confirmarea e a interfeței (decizia
 * mea, ca la conturi și tranzacții): `DELETE` e deja o acțiune explicită a clientului.
 */
export function deleteGoalHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const goalId = routeId(id);
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    await deleteGoal({ db: d.db }, ctx.actor, hh, goalId);
    return noBody();
  });
}

/**
 * O contribuție (`add`) sau o retragere (`withdraw`). `Idempotency-Key` e OBLIGATORIU aici
 * (decizia mea): o contribuție nu e idempotentă prin natura ei, iar o reîncercare fără cheie
 * (rețea instabilă pe mobil) ar dubla suma economisită. Lipsa cheii → 400.
 */
export function contributeGoalHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const goalId = routeId(id);
    const body = await readJsonBody(request);
    if (idempotencyKeyOf(request) === null) {
      throw new ValidationError(
        { "Idempotency-Key": "Antetul Idempotency-Key e obligatoriu pentru contribuții." },
        "Antetul Idempotency-Key lipsește.",
      );
    }
    const hh = await currentHousehold(ctx);
    return idempotentCreate(ctx, hh, body, async (db) => ({
      status: 200,
      body: { data: goalToJson(await contributeToGoal({ db }, ctx.actor, hh, goalId, body)) },
    }));
  });
}

/** Renunțarea la obiectiv (`status: abandoned`); reluarea: `PATCH` cu `status: active`. */
export function abandonGoalHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const goalId = routeId(id);
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    const view = await updateGoal({ db: d.db }, ctx.actor, hh, goalId, { status: "abandoned" });
    return json({ data: goalToJson(view) });
  });
}

// --- Dashboard și raportul lunar -------------------------------------------------------------

export function dashboardHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { month: "string", topCategories: "int" });
    const hh = await currentHousehold(ctx);
    const month = await monthOf(ctx, hh, query.month);
    const view = await getDashboard(planning(d.db, ctx), ctx.actor, hh, {
      month,
      ...(query.topCategories === undefined ? {} : { topCategories: query.topCategories }),
    });
    return json({ data: dashboardToJson(view) });
  });
}

export function monthlyReportHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { month: "string" });
    const hh = await currentHousehold(ctx);
    const month = await monthOf(ctx, hh, query.month);
    const report = await getMonthlyReport(planning(d.db, ctx), ctx.actor, hh, { month });
    return json({ data: monthlyReportToJson(report) });
  });
}

// --- Exporturile CSV -------------------------------------------------------------------------

/** Numele fișierelor: fixe, fără date ale utilizatorului (fără nume, lună sau gospodărie). */
export const EXPORT_FILENAMES = {
  transactions: "finet-tranzactii.csv",
  goals: "finet-obiective.csv",
  budgets: "finet-bugete.csv",
  accounting: "finet-contabilitate.csv",
} as const;

type ExportKind = keyof typeof EXPORT_FILENAMES;

function csvHeaders(kind: ExportKind): Record<string, string> {
  return {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${EXPORT_FILENAMES[kind]}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

const encoder = new TextEncoder();

/**
 * Răspunsul în flux (`ReadableStream`): primul fragment e deja calculat (validarea, numărarea și
 * plafonul au trecut, deci erorile au ieșit ca JSON), restul se cere din generator pe măsură ce
 * clientul citește. Clientul care închide conexiunea oprește generatorul (`return`). O eroare la
 * mijloc (rar: baza indisponibilă) închide fluxul cu eroare și lasă doar un mesaj fix în log.
 */
function streamCsv(
  kind: ExportKind,
  first: string,
  rest: AsyncGenerator<string, void, undefined>,
): Response {
  let sentFirst = false;
  // Clientul poate închide fluxul cât timp o pagină e în lucru: după `cancel` nu se mai scrie nimic.
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentFirst) {
        sentFirst = true;
        controller.enqueue(encoder.encode(first));
        return;
      }
      try {
        const next = await rest.next();
        if (cancelled) return;
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch {
        if (cancelled) return;
        console.error("[api] export CSV întrerupt");
        controller.error(new Error("export întrerupt"));
      }
    },
    async cancel() {
      cancelled = true;
      await rest.return(undefined).catch(() => {});
    },
  });
  return new Response(body, { status: 200, headers: csvHeaders(kind) });
}

const DIALECT_QUERY = { dialect: "string" } as const;

/**
 * Exporturile sunt GET, deci fără verificarea CSRF a mutațiilor; cu sesiune prin cookie, o pagină
 * străină le-ar putea declanșa prin navigare (LOW-2, revizuirea Fazei 3). Regula (decizia mea):
 * - bearer: permis (nu există cookie de folosit cross-site);
 * - cookie: doar `Sec-Fetch-Site` = `same-origin` (descărcarea din UI, `fetch`) sau `none`
 *   (adresa scrisă de utilizator); `same-site`, `cross-site` și antetul LIPSĂ → 403. Browserele
 *   actuale trimit antetul mereu; un client fără el folosește bearer.
 */
export function assertExportFetchSite(ctx: ApiContext): void {
  if (ctx.session.viaBearer) return;
  const site = ctx.request.headers.get("sec-fetch-site");
  if (site !== "same-origin" && site !== "none") {
    throw new ApiError(403, "forbidden", "Cerere refuzată.");
  }
}

async function exportGuard(ctx: ApiContext): Promise<string> {
  assertExportFetchSite(ctx);
  // Exportul e scump (citește toate tranzacțiile filtrate): limită proprie, înaintea oricărei
  // interogări a datelor.
  await enforceRateLimit(ctx, "api_export", ctx.limits.exports);
  return currentHousehold(ctx);
}

export function exportTransactionsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { ...TRANSACTION_FILTER_QUERY, ...DIALECT_QUERY });
    const { dialect, ...filters } = query;
    const rawQuery = transactionQueryOf(filters);
    const hh = await exportGuard(ctx);
    const gen = exportTransactionsCsv(planning(d.db, ctx), ctx.actor, hh, rawQuery, {
      dialect: dialect as CsvDialect | undefined,
      ...(d.exportMaxRows === undefined ? {} : { maxRows: d.exportMaxRows }),
      ...(d.exportPageSize === undefined ? {} : { pageSize: d.exportPageSize }),
    });
    // Primul pas (validare, numărare, plafon, audit) rulează aici: o eroare iese ca JSON.
    const first = await gen.next();
    if (first.done) throw new ApiError(500, "internal_error", "Eroare internă.");
    return streamCsv("transactions", first.value, gen);
  });
}

function csvText(kind: ExportKind, text: string): Response {
  return new Response(text, { status: 200, headers: csvHeaders(kind) });
}

export function exportGoalsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, DIALECT_QUERY);
    const hh = await exportGuard(ctx);
    const text = await exportGoalsCsv(planning(d.db, ctx), ctx.actor, hh, {
      dialect: query.dialect as CsvDialect | undefined,
    });
    return csvText("goals", text);
  });
}

export function exportBudgetsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { month: "string", ...DIALECT_QUERY });
    const hh = await exportGuard(ctx);
    const month = await monthOf(ctx, hh, query.month);
    const text = await exportBudgetsCsv(
      planning(d.db, ctx),
      ctx.actor,
      hh,
      { month },
      { dialect: query.dialect as CsvDialect | undefined },
    );
    return csvText("budgets", text);
  });
}

// --- Exporturile Excel și PDF (Faza 10, F10-C; ADR 0024) -----------------------------------

/** Numele fișierelor Excel/PDF: fixe, fără date ale utilizatorului. */
export const TABLE_EXPORT_FILENAMES = {
  transactions: "finet-tranzactii",
  goals: "finet-obiective",
  budgets: "finet-bugete",
} as const;

export type TableExportFormat = "xlsx" | "pdf";
type TableExportKind = keyof typeof TABLE_EXPORT_FILENAMES;

/** Răspunsul binar al unui export: nume fix, `no-store`, `nosniff`. */
function fileResponse(name: string, format: TableExportFormat, bytes: Uint8Array): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": format === "xlsx" ? XLSX_CONTENT_TYPE : PDF_CONTENT_TYPE,
      "Content-Disposition": `attachment; filename="${name}.${format}"`,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Plafonul rândurilor: Excel ca CSV-ul, PDF mult mai mic (un document de citit, nu de prelucrat). */
function tableRowCap(d: ApiDeps, format: TableExportFormat): number {
  const csvCap = d.exportMaxRows ?? MAX_EXPORT_ROWS;
  return format === "pdf" ? Math.min(csvCap, PDF_MAX_ROWS) : csvCap;
}

function tableOf(format: TableExportFormat, table: Parameters<typeof tableToXlsx>[0]): Uint8Array {
  return format === "xlsx" ? tableToXlsx(table) : tableToPdf(table);
}

export function exportTableHandler(
  request: Request,
  d: ApiDeps,
  kind: TableExportKind,
  format: TableExportFormat,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const options = {
      format,
      maxRows: tableRowCap(d, format),
      ...(d.exportPageSize === undefined ? {} : { pageSize: d.exportPageSize }),
    };
    if (kind === "transactions") {
      const rawQuery = transactionQueryOf(readQuery(request, TRANSACTION_FILTER_QUERY));
      const hh = await exportGuard(ctx);
      const table = await exportTransactionsTable(
        planning(d.db, ctx),
        ctx.actor,
        hh,
        rawQuery,
        options,
      );
      return fileResponse(TABLE_EXPORT_FILENAMES[kind], format, tableOf(format, table));
    }
    if (kind === "goals") {
      readQuery(request, {});
      const hh = await exportGuard(ctx);
      const table = await exportGoalsTable(planning(d.db, ctx), ctx.actor, hh, options);
      return fileResponse(TABLE_EXPORT_FILENAMES[kind], format, tableOf(format, table));
    }
    const query = readQuery(request, { month: "string" });
    const hh = await exportGuard(ctx);
    const month = await monthOf(ctx, hh, query.month);
    const table = await exportBudgetsTable(planning(d.db, ctx), ctx.actor, hh, { month }, options);
    return fileResponse(TABLE_EXPORT_FILENAMES[kind], format, tableOf(format, table));
  });
}

export const exportTransactionsXlsxHandler = (request: Request, d: ApiDeps) =>
  exportTableHandler(request, d, "transactions", "xlsx");
export const exportTransactionsPdfHandler = (request: Request, d: ApiDeps) =>
  exportTableHandler(request, d, "transactions", "pdf");
export const exportGoalsXlsxHandler = (request: Request, d: ApiDeps) =>
  exportTableHandler(request, d, "goals", "xlsx");
export const exportGoalsPdfHandler = (request: Request, d: ApiDeps) =>
  exportTableHandler(request, d, "goals", "pdf");
export const exportBudgetsXlsxHandler = (request: Request, d: ApiDeps) =>
  exportTableHandler(request, d, "budgets", "xlsx");
export const exportBudgetsPdfHandler = (request: Request, d: ApiDeps) =>
  exportTableHandler(request, d, "budgets", "pdf");

/** Exportul pentru contabil (CSV/Excel) și lista bonurilor (Excel/PDF), pe o perioadă aleasă. */
export function exportAccountingHandler(
  request: Request,
  d: ApiDeps,
  kind: "accounting" | "receipts",
  format: "csv" | "xlsx" | "pdf",
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, {
      from: "string",
      to: "string",
      ...(format === "csv" ? DIALECT_QUERY : {}),
    });
    // Dialect necunoscut → 400 (ca la celelalte exporturi CSV), înainte de orice citire.
    const dialect =
      format === "csv"
        ? dialectOf({ dialect: query.dialect as CsvDialect | undefined })
        : undefined;
    const hh = await exportGuard(ctx);
    const table = await exportAccountingTable(
      planning(d.db, ctx),
      ctx.actor,
      hh,
      kind,
      { from: query.from, to: query.to },
      {
        format,
        maxRows: format === "pdf" ? tableRowCap(d, "pdf") : (d.exportMaxRows ?? MAX_EXPORT_ROWS),
      },
    );
    if (format === "csv") {
      return csvText("accounting", tableToCsv(table, dialect));
    }
    const name = kind === "accounting" ? "finet-contabilitate" : "finet-bonuri";
    return fileResponse(name, format, tableOf(format, table));
  });
}

export const exportAccountingCsvHandler = (request: Request, d: ApiDeps) =>
  exportAccountingHandler(request, d, "accounting", "csv");
export const exportAccountingXlsxHandler = (request: Request, d: ApiDeps) =>
  exportAccountingHandler(request, d, "accounting", "xlsx");
export const exportReceiptsXlsxHandler = (request: Request, d: ApiDeps) =>
  exportAccountingHandler(request, d, "receipts", "xlsx");
export const exportReceiptsPdfHandler = (request: Request, d: ApiDeps) =>
  exportAccountingHandler(request, d, "receipts", "pdf");
