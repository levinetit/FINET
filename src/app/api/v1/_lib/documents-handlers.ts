import "server-only";

import { type Storage, getStorage } from "@/lib/storage";
import type { UploadedDocument } from "@/modules/documents/documents.schema";
import { uploadDocuments } from "@/modules/documents/documents.service";
import { UploadError } from "@/modules/documents/multipart";

import { ApiError, type ApiDeps, currentHousehold, enforceRateLimit, handle, json } from "./http";

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

function documentJson(d: UploadedDocument) {
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
    duplicate: d.duplicate,
    createdAt: d.createdAt.toISOString(),
    expiresAt: d.expiresAt?.toISOString() ?? null,
  };
}

export function uploadDocumentsHandler(request: Request, d: DocumentsApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    await enforceRateLimit(ctx, "api_document_upload", ctx.limits.documentUpload);
    const hh = await currentHousehold(ctx);
    try {
      const result = await uploadDocuments(
        {
          db: d.db,
          storage: d.storage ?? getStorage(),
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
