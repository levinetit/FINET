import "server-only";

import type { DbOrTx } from "@/db";
import { CSV_DIALECTS, type CsvDialect } from "@/modules/exports/csv";
import { getInflation, getSeries, listProducts } from "@/modules/prices/prices.service";
import { inflationToJson, productsToJson, seriesToJson } from "@/modules/prices/prices.schema";
import { NotFoundError } from "@/lib/authz";
import { createEntitlements } from "@/modules/entitlements";
import { ValidationError } from "@/lib/errors";
import {
  definitionToJson,
  runToJson,
} from "@/modules/report-definitions/report-definitions.schema";
import {
  createDefinition,
  exportDefinitionCsv,
  getDefinition,
  listDefinitions,
  previewRules,
  removeDefinition,
  runDefinition,
  updateReportDefinition,
} from "@/modules/report-definitions/report-definitions.service";

import {
  ApiError,
  type ApiContext,
  type ApiDeps,
  currentHousehold,
  enforceRateLimit,
  handle,
  idempotentCreate,
  json,
  readJsonBody,
  readOptionalJsonBody,
  readQuery,
  routeId,
  handleAlways,
} from "./http";
import { assertExportFetchSite } from "./planning-handlers";

/**
 * Handlerele prețurilor, inflației și rapoartelor de micro-cheltuieli (Faza 10, F10-B; ADR 0023).
 * Aceleași reguli ca restul `/api/v1` (ADR 0005): sesiune, CSRF pe mutațiile cu cookie,
 * gospodăria din bază (niciodată din cerere), Zod strict în servicii (parametri necunoscuți → 400),
 * 404 uniform, `Idempotency-Key` pe crearea unui raport. Rularea și previzualizarea au o limită
 * proprie (`reportRun`); exportul CSV folosește limita exporturilor și aceeași gardă `Sec-Fetch-Site`.
 *
 * Nicio cerere nu primește `householdId` sau `userId`: ambele vin din sesiune. Conturile personale
 * ale altor membri nu intră în niciun rezultat (vezi `prices.repo.ts`).
 */

const nowOf = (ctx: ApiContext) => () => new Date(ctx.now);
const deps = (d: ApiDeps, ctx: ApiContext, db: DbOrTx = d.db) => ({ db, now: nowOf(ctx) });

// --- Prețuri și inflație ---------------------------------------------------------------------------

const THRESHOLD_QUERY = { minObservations: "int", minMonths: "int" } as const;

export function productsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, {
      months: "int",
      search: "string",
      currency: "string",
      onlyEnough: "bool",
      limit: "int",
      ...THRESHOLD_QUERY,
    });
    const hh = await currentHousehold(ctx);
    return json({ data: productsToJson(await listProducts(deps(d, ctx), ctx.actor, hh, query)) });
  });
}

export function seriesHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, {
      product: "string",
      currency: "string",
      granularity: "string",
      months: "int",
      ...THRESHOLD_QUERY,
    });
    const hh = await currentHousehold(ctx);
    const result = await getSeries(deps(d, ctx), ctx.actor, hh, query);
    if (result === null) throw new NotFoundError();
    return json({ data: seriesToJson(result) });
  });
}

export function inflationHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, {
      months: "int",
      baseline: "string",
      minObservations: "int",
      minItems: "int",
    });
    const hh = await currentHousehold(ctx);
    return json({ data: inflationToJson(await getInflation(deps(d, ctx), ctx.actor, hh, query)) });
  });
}

// --- Definițiile rapoartelor ---------------------------------------------------------------------

export function listReportDefinitionsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { includeArchived: "bool" });
    const hh = await currentHousehold(ctx);
    const list = await listDefinitions(deps(d, ctx), ctx.actor, hh, query);
    return json({ data: list.map(definitionToJson) });
  });
}

export function createReportDefinitionHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    // Rapoarte personalizate: funcție legată de plan (Faza 12-A); în `personal` mereu permisă.
    if (!(await createEntitlements(d.config.appMode, d.config, d.db).can(hh, "reports.custom"))) {
      throw new ApiError(403, "forbidden", "Funcția nu e disponibilă în planul curent.");
    }
    return idempotentCreate(ctx, hh, body, async (db) => ({
      status: 201,
      body: {
        data: definitionToJson(await createDefinition(deps(d, ctx, db), ctx.actor, hh, body)),
      },
    }));
  });
}

export function getReportDefinitionHandler(
  request: Request,
  d: ApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const defId = routeId(id);
    readQuery(request, {});
    const hh = await currentHousehold(ctx);
    return json({
      data: definitionToJson(await getDefinition(deps(d, ctx), ctx.actor, hh, defId)),
    });
  });
}

export function patchReportDefinitionHandler(
  request: Request,
  d: ApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const defId = routeId(id);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    const updated = await updateReportDefinition(deps(d, ctx), ctx.actor, hh, defId, body);
    return json({ data: definitionToJson(updated) });
  });
}

export function deleteReportDefinitionHandler(
  request: Request,
  d: ApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const defId = routeId(id);
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    await removeDefinition(deps(d, ctx), ctx.actor, hh, defId);
    return json(null, 204);
  });
}

// --- Rularea, previzualizarea, exportul ------------------------------------------------------------

export function runReportHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const defId = routeId(id);
    const query = readQuery(request, { period: "string" });
    await enforceRateLimit(ctx, "api_report_run", ctx.limits.reportRun);
    const hh = await currentHousehold(ctx);
    const result = await runDefinition(deps(d, ctx), ctx.actor, hh, defId, query);
    return json({ data: runToJson(result) });
  });
}

export function previewReportHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handleAlways(request, d, async (ctx) => {
    const body = await readJsonBody(request);
    await enforceRateLimit(ctx, "api_report_run", ctx.limits.reportRun);
    const hh = await currentHousehold(ctx);
    const result = await previewRules(deps(d, ctx), ctx.actor, hh, body);
    return json({ data: runToJson(result) });
  });
}

export const REPORT_EXPORT_FILENAME = "finet-raport.csv";

export function exportReportHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const defId = routeId(id);
    const query = readQuery(request, { period: "string", dialect: "string" });
    assertExportFetchSite(ctx);
    await enforceRateLimit(ctx, "api_export", ctx.limits.exports);
    const { dialect, ...rest } = query;
    if (dialect !== undefined && !(CSV_DIALECTS as readonly unknown[]).includes(dialect)) {
      throw new ValidationError({ dialect: "Dialect necunoscut." });
    }
    const hh = await currentHousehold(ctx);
    const out = await exportDefinitionCsv(deps(d, ctx), ctx.actor, hh, defId, rest, {
      dialect: dialect as CsvDialect | undefined,
    });
    return new Response(out.csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${REPORT_EXPORT_FILENAME}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
