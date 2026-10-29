import "server-only";

import { once } from "node:events";

import busboy from "busboy";

import { STATEMENT_UPLOAD_MAX_BYTES } from "./files";

/**
 * Corpul `multipart/form-data` al încărcării unui extras (F7-B): UN singur fișier (câmpul `file`,
 * ≤ 20 MB, ținut în memorie: CSV/XLSX/ZIP se citesc oricum întregi, iar PDF-ul se scrie apoi în
 * storage) și câmpurile text `accountId` (≤ 64) și `mapping` (JSON ≤ 4 KB). Orice alt câmp, un al
 * doilea fișier, un câmp repetat sau trunchiat, un corp trunchiat → eroare cu motiv stabil.
 * `Content-Length` peste plafon → 413 înainte de citire; plafonul dur se aplică și pe octeții
 * efectiv citiți. Tipul fișierului NU se ia din antete (se detectează după conținut, mai departe).
 */

export const STATEMENT_FIELDS = ["accountId", "mapping"] as const;
export const STATEMENT_FILE_FIELD = "file";
const FIELD_MAX = { accountId: 64, mapping: 4096 } as const;
const OVERHEAD = 16 * 1024;

export type StatementUploadErrorReason =
  | "unsupported_media_type"
  | "payload_too_large"
  | "file_too_large"
  | "too_many_files"
  | "no_files"
  | "invalid_multipart"
  | "invalid_field"
  | "empty_file";

export class StatementUploadError extends Error {
  constructor(
    readonly status: 400 | 413 | 415,
    readonly reason: StatementUploadErrorReason,
  ) {
    super("Încărcarea nu a fost acceptată.");
    this.name = "StatementUploadError";
  }
}

export type StatementMultipart = Readonly<{
  bytes: Buffer;
  fields: Readonly<Partial<Record<(typeof STATEMENT_FIELDS)[number], string>>>;
}>;

export async function readStatementMultipart(
  request: Request,
  maxFileBytes: number = STATEMENT_UPLOAD_MAX_BYTES,
): Promise<StatementMultipart> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;.*boundary=/i.test(contentType)) {
    throw new StatementUploadError(415, "unsupported_media_type");
  }
  const bodyLimit = maxFileBytes + FIELD_MAX.mapping + OVERHEAD;
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d{1,15}$/.test(declared)) throw new StatementUploadError(400, "invalid_multipart");
    if (Number(declared) > bodyLimit) throw new StatementUploadError(413, "payload_too_large");
  }
  if (!request.body) throw new StatementUploadError(400, "no_files");

  let bb: busboy.Busboy;
  try {
    bb = busboy({
      headers: { "content-type": contentType },
      limits: {
        files: 1,
        // busboy marchează `truncated`/`valueTruncated` și la o valoare EXACT egală cu limita:
        // +1 aici, iar plafonul real e verificat explicit mai jos (`size > max`, `length > max`).
        fileSize: maxFileBytes + 1,
        fields: STATEMENT_FIELDS.length,
        fieldSize: FIELD_MAX.mapping + 1,
        fieldNameSize: 32,
        // busboy semnalează `partsLimit` deja la atingerea plafonului: +1 (fișierele și câmpurile
        // în plus sunt refuzate oricum, mai sus).
        parts: 2 + STATEMENT_FIELDS.length,
        headerPairs: 16,
      },
      defParamCharset: "utf8",
    });
  } catch {
    throw new StatementUploadError(400, "invalid_multipart");
  }

  let failure: StatementUploadError | null = null;
  const fail = (e: StatementUploadError) => {
    failure ??= e;
  };
  const chunks: Buffer[] = [];
  let size = 0;
  let files = 0;
  let fileDone: Promise<void> = Promise.resolve();
  const fields: Partial<Record<(typeof STATEMENT_FIELDS)[number], string>> = {};

  bb.on("file", (name, stream) => {
    stream.on("error", () => {});
    files++;
    if (name !== STATEMENT_FILE_FIELD || files > 1) {
      fail(new StatementUploadError(400, files > 1 ? "too_many_files" : "invalid_field"));
      stream.resume();
      return;
    }
    fileDone = (async () => {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > maxFileBytes) {
          fail(new StatementUploadError(413, "file_too_large"));
          continue;
        }
        if (!failure) chunks.push(chunk);
        else chunks.length = 0;
      }
      if ((stream as { truncated?: boolean }).truncated) {
        fail(new StatementUploadError(413, "file_too_large"));
      }
    })();
  });
  bb.on("field", (name, value, info) => {
    const known = (STATEMENT_FIELDS as readonly string[]).includes(name);
    if (!known || info.valueTruncated || Object.hasOwn(fields, name)) {
      fail(new StatementUploadError(400, "invalid_field"));
      return;
    }
    const key = name as (typeof STATEMENT_FIELDS)[number];
    if (value.length > FIELD_MAX[key]) {
      fail(new StatementUploadError(400, "invalid_field"));
      return;
    }
    fields[key] = value;
  });
  bb.on("filesLimit", () => fail(new StatementUploadError(413, "too_many_files")));
  bb.on("fieldsLimit", () => fail(new StatementUploadError(400, "invalid_field")));
  bb.on("partsLimit", () => fail(new StatementUploadError(400, "invalid_multipart")));
  let closed = false;
  const finished = new Promise<void>((resolve) => {
    bb.on("error", () => {
      fail(new StatementUploadError(400, "invalid_multipart"));
      resolve();
    });
    bb.on("close", () => {
      closed = true;
      resolve();
    });
  });

  let total = 0;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > bodyLimit) fail(new StatementUploadError(413, "payload_too_large"));
      if (failure) break;
      if (!bb.write(value)) await Promise.race([once(bb, "drain"), finished]);
    }
  } catch {
    fail(new StatementUploadError(400, "invalid_multipart"));
  }
  if (failure) {
    await reader.cancel().catch(() => {});
    bb.destroy();
    throw failure;
  }
  bb.end();
  await finished;
  await fileDone;
  if (failure) throw failure;
  // Fără delimitatorul final (corp trunchiat) busboy nu se închide normal.
  if (!closed) throw new StatementUploadError(400, "invalid_multipart");
  if (files === 0) throw new StatementUploadError(400, "no_files");
  if (size === 0) throw new StatementUploadError(400, "empty_file");
  // O singură copie (bucățile se unesc o dată), apoi bucățile se eliberează imediat (M1).
  const bytes = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, size);
  chunks.length = 0;
  return { bytes, fields };
}
