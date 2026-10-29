import "server-only";

import { type Currency, money, toJson } from "@/lib/money";
import { type Storage, getStorage } from "@/lib/storage";
import { type StatementUploadError, readStatementMultipart } from "@/modules/statements/multipart";
import {
  type CoverageRow,
  type StatementImportView,
  cancelStatementImport,
  confirmStatementImport,
  discardStatementPreview,
  getStatementCoverage,
  getStatementImport,
  listStatementImports,
} from "@/modules/statements/statements.service";
import { StatementError } from "@/modules/statements/types";
import {
  type StatementUploadView,
  type UploadPartOutcome,
  cancelStatementUpload,
  getStatementUpload,
  importStatementUpload,
  listStatementUploads,
  parseMappingField,
  releaseUploadFiles,
  uploadFilesOfImport,
} from "@/modules/statements/uploads.service";

import {
  ApiError,
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
} from "./http";

/**
 * Handlerele extraselor (Faza 7, F7-B; ADR 0018 §11). Aceleași reguli ca restul API-ului: sesiune,
 * CSRF/Origin pe mutațiile cu cookie, gospodăria din sesiune/bază (niciodată din cerere), 404
 * uniform pentru orice resursă invizibilă (inclusiv importurile/încărcările pe conturile PERSONALE
 * ale altor membri), Zod strict în servicii, erori cu cod fix, rate limiting pe mutații plus o
 * limită proprie pe încărcare. Confirmarea acceptă `Idempotency-Key`. După confirmare sau renunțare,
 * fișierele PDF sursă se șterg (best effort; restul îl face curățarea periodică).
 *
 * Fără evenimente live pentru importuri (decizia mea): un import atinge multe tranzacții, iar
 * evenimentele poartă un singur id; clientul reîncarcă lista.
 */

export type StatementsApiDeps = ApiDeps & Readonly<{ storage?: Storage }>;

const storageOf = (d: StatementsApiDeps): Storage => d.storage ?? getStorage();
const deps = (d: StatementsApiDeps, now: number) => ({
  db: d.db,
  storage: storageOf(d),
  now: () => new Date(now),
});

const minor = (v: bigint, c: Currency) => toJson(money(v, c)).amountMinor;
const minorOrNull = (v: bigint | null, c: Currency) => (v === null ? null : minor(v, c));

export function importToJson(v: StatementImportView) {
  return {
    id: v.id,
    accountId: v.accountId,
    currency: v.currency,
    bank: v.bank,
    format: v.format,
    status: v.status,
    periodStart: v.periodStart,
    periodEnd: v.periodEnd,
    openingBalanceMinor: minorOrNull(v.openingBalanceMinor, v.currency),
    closingBalanceMinor: minorOrNull(v.closingBalanceMinor, v.currency),
    computedClosingMinor: minorOrNull(v.computedClosingMinor, v.currency),
    balanceStatus: v.balanceStatus,
    lineCount: v.lineCount,
    newCount: v.newCount,
    duplicateCount: v.duplicateCount,
    pendingCount: v.pendingCount,
    importedCount: v.importedCount,
    warnings: [...v.warnings],
    createdAt: v.createdAt.toISOString(),
    importedAt: v.importedAt?.toISOString() ?? null,
    cancelledAt: v.cancelledAt?.toISOString() ?? null,
    ...(v.lines
      ? {
          lines: v.lines.map((l) => ({
            rowNo: l.rowNo,
            occurredOn: l.occurredOn,
            direction: l.direction,
            amountMinor: minor(l.amountMinor, v.currency),
            description: l.description,
            bankReference: l.bankReference,
            kind: l.kind,
            fxAmountMinor: l.fxCurrency ? minorOrNull(l.fxAmountMinor, l.fxCurrency) : null,
            fxCurrency: l.fxCurrency,
            balanceAfterMinor: minorOrNull(l.balanceAfterMinor, v.currency),
            state: l.state,
            transactionId: l.transactionId,
          })),
        }
      : {}),
  };
}

export function uploadToJson(u: StatementUploadView) {
  return {
    id: u.id,
    accountId: u.accountId,
    currency: u.currency,
    status: u.status,
    errorCode: u.errorCode,
    importId: u.importId,
    partIndex: u.partIndex,
    sizeBytes: u.sizeBytes,
    createdAt: u.createdAt.toISOString(),
    expiresAt: u.expiresAt.toISOString(),
    fileDeleted: u.fileDeleted,
  };
}

function partToJson(p: UploadPartOutcome) {
  switch (p.kind) {
    case "queued":
      return {
        index: p.index,
        kind: p.kind,
        upload: uploadToJson(p.upload),
        duplicate: p.duplicate,
      };
    case "preview":
      return {
        index: p.index,
        kind: p.kind,
        import: importToJson(p.preview.import),
        alreadyImported: p.preview.alreadyImported,
        balanceReasons: [...p.preview.balanceReasons],
      };
    case "mapping_required":
      return {
        index: p.index,
        kind: p.kind,
        format: p.format,
        columnCount: p.columnCount,
        rowCount: p.rowCount,
        sample: p.sample.map((r) => [...r]),
        suggestion: {
          mapping: p.suggestion.mapping,
          missing: [...p.suggestion.missing],
          template: p.suggestion.template,
        },
      };
    case "rejected":
      return { index: p.index, kind: p.kind, code: p.code };
  }
}

export function coverageToJson(rows: readonly CoverageRow[]) {
  return rows.map((r) => ({
    accountId: r.accountId,
    accountName: r.accountName,
    currency: r.currency,
    months: r.months.map((c) => ({ ...c })),
    missingMonths: [...r.missingMonths],
  }));
}

const UPLOAD_MESSAGES: Readonly<Record<StatementUploadError["reason"], string>> = {
  unsupported_media_type: "Cererea trebuie trimisă ca multipart/form-data.",
  payload_too_large: "Cererea e prea mare.",
  file_too_large: "Fișierul depășește 20 MB.",
  too_many_files: "Se încarcă un singur fișier odată (un ZIP pentru mai multe).",
  no_files: "Nu a fost trimis niciun fișier.",
  invalid_multipart: "Cererea nu a putut fi citită complet.",
  invalid_field: "Cererea conține câmpuri nepermise.",
  empty_file: "Fișierul e gol.",
};

/** Mesajele (fixe) ale codurilor de citire a extrasului. */
const STATEMENT_MESSAGE = "Extrasul nu a putut fi citit.";

export function uploadStatementHandler(request: Request, d: StatementsApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    await enforceRateLimit(ctx, "api_statement_upload", ctx.limits.statementUpload);
    const hh = await currentHousehold(ctx);
    let body;
    try {
      body = await readStatementMultipart(request);
    } catch (error) {
      const e = error as StatementUploadError;
      if (e?.name === "StatementUploadError") {
        throw new ApiError(e.status, e.reason, UPLOAD_MESSAGES[e.reason]);
      }
      throw error;
    }
    const accountId = body.fields.accountId;
    if (!accountId) {
      throw new ApiError(400, "validation_failed", "Alege contul extrasului.", {
        fields: { accountId: "Câmp obligatoriu." },
      });
    }
    const mapping = parseMappingField(body.fields.mapping);
    try {
      const parts = await importStatementUpload(deps(d, ctx.now), ctx.actor, hh, {
        accountId,
        bytes: body.bytes,
        ...(mapping !== undefined ? { mapping } : {}),
      });
      const created = parts.some(
        (p) =>
          (p.kind === "queued" && !p.duplicate) ||
          (p.kind === "preview" && !p.preview.alreadyImported),
      );
      return json({ data: { parts: parts.map(partToJson) } }, created ? 201 : 200);
    } catch (error) {
      if (error instanceof StatementError) {
        throw new ApiError(422, error.code, STATEMENT_MESSAGE, { reason: error.code });
      }
      throw error;
    }
  });
}

export function listUploadsHandler(request: Request, d: StatementsApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    readQuery(request, {});
    const hh = await currentHousehold(ctx);
    const list = await listStatementUploads(deps(d, ctx.now), ctx.actor, hh);
    return json({ data: list.map(uploadToJson) });
  });
}

export function getUploadHandler(
  request: Request,
  d: StatementsApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const uploadId = routeId(id);
    readQuery(request, {});
    const hh = await currentHousehold(ctx);
    return json({
      data: uploadToJson(await getStatementUpload(deps(d, ctx.now), ctx.actor, hh, uploadId)),
    });
  });
}

export function cancelUploadHandler(
  request: Request,
  d: StatementsApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const uploadId = routeId(id);
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    const v = await cancelStatementUpload(deps(d, ctx.now), ctx.actor, hh, uploadId);
    return json({ data: uploadToJson(v) });
  });
}

export function listImportsHandler(request: Request, d: StatementsApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const raw = readQuery(request, { accountId: "string", limit: "int" });
    const hh = await currentHousehold(ctx);
    const list = await listStatementImports(deps(d, ctx.now), ctx.actor, hh, raw);
    return json({ data: list.map(importToJson) });
  });
}

export function getImportHandler(
  request: Request,
  d: StatementsApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const importId = routeId(id);
    readQuery(request, {});
    const hh = await currentHousehold(ctx);
    return json({
      data: importToJson(await getStatementImport(deps(d, ctx.now), ctx.actor, hh, importId)),
    });
  });
}

/** Confirmarea (tranzacțiile create în aceeași tranzacție SQL; `Idempotency-Key` opțional). */
export function confirmImportHandler(
  request: Request,
  d: StatementsApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const importId = routeId(id);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    const files = await uploadFilesOfImport(deps(d, ctx.now), ctx.actor, hh, importId);
    const response = await idempotentCreate(ctx, hh, body, async (db) => {
      const v = await confirmStatementImport(
        { ...deps(d, ctx.now), db },
        ctx.actor,
        hh,
        importId,
        body,
      );
      return { status: 200, body: { data: importToJson(v) } };
    });
    if (response.ok) await releaseUploadFiles(deps(d, ctx.now), ctx.actor, hh, files);
    return response;
  });
}

export function cancelImportHandler(
  request: Request,
  d: StatementsApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const importId = routeId(id);
    const body = (await readOptionalJsonBody(request)) ?? {};
    const hh = await currentHousehold(ctx);
    const v = await cancelStatementImport(deps(d, ctx.now), ctx.actor, hh, importId, body);
    return json({ data: { ...importToJson(v), keptEdited: v.keptEdited } });
  });
}

/** Renunțarea la o previzualizare neconfirmată (o șterge cu rândurile și fișierul sursă). */
export function discardImportHandler(
  request: Request,
  d: StatementsApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const importId = routeId(id);
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    const files = await uploadFilesOfImport(deps(d, ctx.now), ctx.actor, hh, importId);
    await discardStatementPreview(deps(d, ctx.now), ctx.actor, hh, importId);
    await releaseUploadFiles(deps(d, ctx.now), ctx.actor, hh, files);
    return json(null, 204);
  });
}

export function coverageHandler(request: Request, d: StatementsApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const raw = readQuery(request, { from: "string", to: "string" });
    const hh = await currentHousehold(ctx);
    const rows = await getStatementCoverage(deps(d, ctx.now), ctx.actor, hh, raw);
    return json({ data: coverageToJson(rows) });
  });
}
