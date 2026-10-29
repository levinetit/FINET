import "server-only";

import { type Storage, getStorage } from "@/lib/storage";
import type { DocumentView, UploadedDocument } from "@/modules/documents/documents.schema";
import {
  type DocumentListItem,
  dailyUsage,
  deleteDocument,
  getDocumentWithReceipt,
  listDocuments,
  openDocumentFile,
  uploadDocuments,
} from "@/modules/documents/documents.service";
import { UploadError } from "@/modules/documents/multipart";

import {
  ApiError,
  type ApiDeps,
  currentHousehold,
  enforceRateLimit,
  handle,
  json,
  readOptionalJsonBody,
  readQuery,
  routeId,
} from "./http";

/**
 * Handlerul încărcării documentelor (F6-A: pregătit și testat; ruta publică
 * `POST /api/v1/documents`, OpenAPI și UI-ul vin în F6-C). Aceleași reguli ca restul API-ului:
 * sesiune, CSRF pe cookie, gospodăria din sesiune/bază, rate limiting (`mutations` + limita
 * proprie `documentUpload`) ÎNAINTE de citirea corpului. Corpul se citește în flux
 * (`multipart/form-data`), cu limite dure (ADR 0013). Fără `Idempotency-Key`: încărcarea e
 * idempotentă prin deduplicarea SHA-256 (același fișier → același document).
 *
 * Erorile de încărcare: `413 payload_too_large|file_too_large|too_many_files|image_too_large`,
 * `415 unsupported_media_type|unsupported_type|heic_unsupported|markup_content`,
 * `422 invalid_image`, `400 no_files|invalid_multipart|invalid_field|empty_file`; limitele de
 * domeniu sunt `409` (`daily_document_limit`, `storage_quota_exceeded`, `long_receipt_duplicate`).
 */

export type DocumentsApiDeps = ApiDeps & Readonly<{ storage?: Storage }>;

const UPLOAD_MESSAGES: Readonly<Record<UploadError["reason"], string>> = {
  unsupported_media_type: "Cererea trebuie trimisă ca multipart/form-data.",
  payload_too_large: "Cererea e prea mare.",
  file_too_large: "Un fișier depășește dimensiunea maximă.",
  too_many_files: "Prea multe fișiere într-o singură încărcare (maximum 4).",
  no_files: "Nu a fost trimis niciun fișier.",
  invalid_multipart: "Cererea nu a putut fi citită complet.",
  invalid_field: "Cererea conține câmpuri nepermise.",
  empty_file: "Fișierul e gol.",
  unsupported_type: "Tip de fișier neacceptat. Se acceptă JPEG, PNG, WebP și PDF.",
  heic_unsupported:
    "Pozele HEIC/HEIF nu sunt acceptate încă: convertește-le în JPEG (aplicația Android o face singură).",
  markup_content: "Fișierul conține cod sau marcaje și nu e acceptat.",
  invalid_image: "Imaginea nu poate fi citită.",
  image_too_large: "Imaginea are prea mulți pixeli.",
};

function viewJson(d: DocumentView) {
  return {
    id: d.id,
    kind: d.kind,
    status: d.status,
    mime: d.mime,
    sizeBytes: d.sizeBytes,
    pages: d.pages,
    batchId: d.batchId,
    documentOrder: d.documentOrder,
    possibleDuplicateOfId: d.possibleDuplicateOfId,
    errorCode: d.errorCode,
    createdAt: d.createdAt.toISOString(),
    expiresAt: d.expiresAt?.toISOString() ?? null,
    fileDeleted: d.fileDeleted,
  };
}

function documentJson(d: UploadedDocument) {
  return { ...viewJson(d), duplicate: d.duplicate };
}

export function documentItemJson(d: DocumentListItem) {
  return { ...viewJson(d), receiptId: d.receiptId };
}

export function uploadDocumentsHandler(request: Request, d: DocumentsApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    await enforceRateLimit(ctx, "api_document_upload", ctx.limits.documentUpload);
    const hh = await currentHousehold(ctx);
    try {
      const result = await uploadDocuments(
        {
          db: d.db,
          storage: storageOf(d),
          config: d.config,
          now: () => new Date(ctx.now),
        },
        ctx.actor,
        hh,
        request,
      );
      return json(
        {
          data: {
            documents: result.documents.map(documentJson),
            batchId: result.batchId,
            created: result.created,
          },
        },
        result.created > 0 ? 201 : 200,
      );
    } catch (error) {
      if (error instanceof UploadError) {
        throw new ApiError(error.status, error.reason, UPLOAD_MESSAGES[error.reason]);
      }
      throw error;
    }
  });
}

const storageOf = (d: DocumentsApiDeps): Storage => d.storage ?? getStorage();

const docDeps = (d: DocumentsApiDeps, now: number) => ({
  db: d.db,
  storage: storageOf(d),
  config: d.config,
  now: () => new Date(now),
});

/** Documentele gospodăriei (cele mai noi întâi), cu starea și bonul extras din ele. */
export function listDocumentsHandler(request: Request, d: DocumentsApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const raw = readQuery(request, { status: "string", since: "string", limit: "int" });
    const hh = await currentHousehold(ctx);
    const list = await listDocuments(docDeps(d, ctx.now), ctx.actor, hh, raw);
    return json({ data: list.map(documentItemJson) });
  });
}

export function getDocumentHandler(
  request: Request,
  d: DocumentsApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const docId = routeId(id);
    readQuery(request, {});
    const hh = await currentHousehold(ctx);
    const doc = await getDocumentWithReceipt(docDeps(d, ctx.now), ctx.actor, hh, docId);
    return json({ data: documentItemJson(doc) });
  });
}

const EXTENSIONS: Readonly<Record<DocumentView["mime"], string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/**
 * Fișierul original, în flux, doar pentru membri (404 uniform altfel). Antete fixe: tipul DETECTAT
 * după conținut (niciodată HTML/SVG), `Content-Disposition: attachment` cu un nume generat de
 * server (id-ul), `nosniff`, `no-store`, un CSP care nu permite nimic (`sandbox`) și
 * `Cross-Origin-Resource-Policy: same-origin`. `<img>` îl afișează (ignoră `attachment`).
 */
export function documentFileHandler(
  request: Request,
  d: DocumentsApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const docId = routeId(id);
    readQuery(request, {});
    const hh = await currentHousehold(ctx);
    const file = await openDocumentFile(docDeps(d, ctx.now), ctx.actor, hh, docId);
    return new Response(file.body, {
      status: 200,
      headers: {
        "Content-Type": file.mime,
        "Content-Length": String(file.sizeBytes),
        "Content-Disposition": `attachment; filename="bon-${file.id}.${EXTENSIONS[file.mime]}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  });
}

/** Șterge documentul și fișierul (5.6); bonul extras dispare în cascadă, tranzacția rămâne. */
export function deleteDocumentHandler(
  request: Request,
  d: DocumentsApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const docId = routeId(id);
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    await deleteDocument(docDeps(d, ctx.now), ctx.actor, hh, docId);
    return json(null, 204);
  });
}

/** Contorul zilei („X din Y documente azi”), fără costuri sau bugete. */
export function aiUsageHandler(request: Request, d: DocumentsApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    readQuery(request, {});
    const hh = await currentHousehold(ctx);
    const usage = await dailyUsage(docDeps(d, ctx.now), ctx.actor, hh);
    return json({
      data: {
        used: usage.used,
        limit: usage.limit,
        remaining: Math.max(0, usage.limit - usage.used),
      },
    });
  });
}
