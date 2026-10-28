import "server-only";

import { createHash } from "node:crypto";
import { once } from "node:events";

import busboy from "busboy";

import { type Storage, type StorageKey, StorageLimitError } from "@/lib/storage";

import { type AcceptedMime, ContentRejectedError, HEAD_BYTES, validateHead } from "./content";

/**
 * Primirea fișierelor încărcate (`multipart/form-data`) în FLUX (master prompt 6.3; ADR 0013):
 * corpul nu se ține în memorie. Fiecare fișier trece printr-un generator care:
 * 1. calculează SHA-256 pe măsură ce sosesc octeții;
 * 2. reține doar primii `HEAD_BYTES` octeți și îi validează (tip după conținut, dimensiunile
 *    imaginii din antet) ÎNAINTE de a lăsa restul să curgă;
 * 3. e scris în storage cu `putStream` (temporar + rename), cu plafonul `maxFileBytes`.
 * Orice eroare (tip refuzat, fișier prea mare, corp trunchiat, prea multe fișiere) șterge
 * fișierele deja scrise în această cerere. Limita dură pe TOT corpul: `maxFiles × maxFileBytes`
 * plus o marjă pentru antete și câmpuri; `Content-Length` mai mare → 413 înainte de citire.
 *
 * ATENȚIE (Next 16, verificat în documentație): când `src/proxy.ts` rulează pe rută, Next
 * copiază corpul în memorie până la `proxyClientMaxBodySize` (implicit 10 MB) și TRUNCHIAZĂ
 * restul fără eroare. Un corp trunchiat nu are delimitatorul final, deci e respins aici
 * (`invalid_multipart`), dar ruta din F6-C trebuie să ridice limita (ADR 0013).
 */

export type UploadLimits = Readonly<{
  maxFileBytes: number;
  maxFiles: number;
  maxImagePixels: number;
}>;

export type ReceivedFile = Readonly<{
  key: StorageKey;
  sizeBytes: number;
  sha256: string;
  mime: AcceptedMime;
  /** Tipul declarat de client (doar informativ), normalizat sau `null`. */
  declaredMime: string | null;
  /** Ordinea în cerere (0, 1, …): ordinea pozelor unui bon lung. */
  index: number;
}>;

export type ReceivedUpload = Readonly<{
  files: readonly ReceivedFile[];
  fields: Readonly<Record<string, string>>;
}>;

export type UploadErrorReason =
  | "unsupported_media_type"
  | "payload_too_large"
  | "file_too_large"
  | "too_many_files"
  | "no_files"
  | "invalid_multipart"
  | "invalid_field"
  | ContentRejectedError["reason"];

/** Eroare de încărcare cu status HTTP și motiv stabil (fără ecou din conținut sau nume). */
export class UploadError extends Error {
  constructor(
    readonly status: 400 | 413 | 415 | 422,
    readonly reason: UploadErrorReason,
  ) {
    super("Încărcarea nu a fost acceptată.");
    this.name = "UploadError";
  }
}

/** Câmpul fișierelor și câmpurile text permise (restul → 400). */
export const FILE_FIELD = "files";
export const TEXT_FIELDS = ["kind", "longReceipt"] as const;
/** Marja corpului pentru antetele părților și câmpurile text. */
export const BODY_OVERHEAD_BYTES = 64 * 1024;

const CONTENT_REJECTION_STATUS: Readonly<
  Record<ContentRejectedError["reason"], 400 | 413 | 415 | 422>
> = {
  empty_file: 400,
  unsupported_type: 415,
  heic_unsupported: 415,
  markup_content: 415,
  invalid_image: 422,
  image_too_large: 413,
};

const DECLARED_MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,49}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,49}$/;

function normalizeDeclaredMime(value: string | undefined): string | null {
  const v = (value ?? "").trim().toLowerCase();
  return DECLARED_MIME.test(v) ? v : null;
}

function toUploadError(error: unknown): UploadError | null {
  if (error instanceof UploadError) return error;
  if (error instanceof ContentRejectedError) {
    return new UploadError(CONTENT_REJECTION_STATUS[error.reason], error.reason);
  }
  if (error instanceof StorageLimitError) return new UploadError(413, "file_too_large");
  return null;
}

/** Plafonul întregului corp pentru limitele date. */
export function maxBodyBytes(limits: UploadLimits): number {
  return limits.maxFiles * limits.maxFileBytes + BODY_OVERHEAD_BYTES;
}

/**
 * Citește cererea și scrie fișierele în storage (sub `households/<householdId>/documents/`).
 * Întoarce fișierele primite (în ordinea din cerere) și câmpurile text permise.
 */
export async function receiveMultipart(
  request: Request,
  storage: Storage,
  householdId: string,
  limits: UploadLimits,
): Promise<ReceivedUpload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;.*boundary=/i.test(contentType)) {
    throw new UploadError(415, "unsupported_media_type");
  }
  const bodyLimit = maxBodyBytes(limits);
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d{1,15}$/.test(declared)) throw new UploadError(400, "invalid_multipart");
    if (Number(declared) > bodyLimit) throw new UploadError(413, "payload_too_large");
  }
  if (!request.body) throw new UploadError(400, "no_files");

  let bb: busboy.Busboy;
  try {
    bb = busboy({
      headers: { "content-type": contentType },
      limits: {
        files: limits.maxFiles,
        fileSize: limits.maxFileBytes,
        fields: TEXT_FIELDS.length,
        fieldSize: 64,
        fieldNameSize: 32,
        parts: limits.maxFiles + TEXT_FIELDS.length,
        headerPairs: 16,
      },
      defParamCharset: "utf8",
    });
  } catch {
    throw new UploadError(400, "invalid_multipart");
  }

  const stored: StorageKey[] = [];
  const results: ReceivedFile[] = [];
  const pending: Promise<void>[] = [];
  const fields: Record<string, string> = {};
  let failure: unknown = null;
  let fileIndex = 0;
  const fail = (error: unknown) => {
    failure ??= error;
  };

  bb.on("file", (name, stream, info) => {
    const index = fileIndex++;
    // Erorile fluxului (de exemplu la oprirea parserului) sunt deja tratate prin `failure`.
    stream.on("error", () => {});
    if (failure || name !== FILE_FIELD) {
      if (!failure) fail(new UploadError(400, "invalid_field"));
      stream.resume();
      return;
    }
    const hash = createHash("sha256");
    let size = 0;
    let mime: AcceptedMime | null = null;
    const source = async function* (): AsyncGenerator<Uint8Array> {
      const head: Buffer[] = [];
      let headLength = 0;
      let checked = false;
      const check = () => {
        mime = validateHead(Buffer.concat(head), limits).mime;
        checked = true;
      };
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        if (failure) throw failure;
        hash.update(chunk);
        size += chunk.length;
        if (checked) {
          yield chunk;
          continue;
        }
        head.push(chunk);
        headLength += chunk.length;
        if (headLength >= HEAD_BYTES) {
          check();
          yield* head;
        }
      }
      // busboy oprește fluxul la `fileSize` și marchează `truncated`.
      if ((stream as { truncated?: boolean }).truncated)
        throw new UploadError(413, "file_too_large");
      if (!checked) {
        check();
        yield* head;
      }
    };
    pending.push(
      storage
        .putStream(source(), { householdId, maxBytes: limits.maxFileBytes })
        .then((key) => {
          stored.push(key);
          results.push({
            key,
            sizeBytes: size,
            sha256: hash.digest("hex"),
            mime: mime!,
            declaredMime: normalizeDeclaredMime(info.mimeType),
            index,
          });
        })
        .catch((error: unknown) => {
          fail(error);
          // Fluxul trebuie golit, altfel busboy nu mai avansează.
          stream.resume();
        }),
    );
  });
  bb.on("field", (name, value, info) => {
    if (!(TEXT_FIELDS as readonly string[]).includes(name) || info.valueTruncated) {
      fail(new UploadError(400, "invalid_field"));
      return;
    }
    if (Object.hasOwn(fields, name)) {
      fail(new UploadError(400, "invalid_field"));
      return;
    }
    fields[name] = value;
  });
  bb.on("filesLimit", () => fail(new UploadError(413, "too_many_files")));
  bb.on("fieldsLimit", () => fail(new UploadError(400, "invalid_field")));
  bb.on("partsLimit", () => fail(new UploadError(400, "invalid_multipart")));
  const finished = new Promise<void>((resolve) => {
    bb.on("error", () => {
      fail(new UploadError(400, "invalid_multipart"));
      resolve();
    });
    bb.on("close", () => resolve());
  });

  // Pompa: corpul cererii → busboy, cu plafonul dur pe octeți și cu backpressure. Cititorul web
  // e anulat (nu distrus) la oprire, ca sursa să nu mai scrie într-un flux închis.
  let total = 0;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > bodyLimit) fail(new UploadError(413, "payload_too_large"));
      if (failure) break;
      if (!bb.write(value)) await Promise.race([once(bb, "drain"), finished]);
    }
  } catch {
    fail(new UploadError(400, "invalid_multipart"));
  }
  if (failure) await reader.cancel().catch(() => {});
  if (failure) bb.destroy();
  else bb.end();
  await finished;
  await Promise.all(pending);

  if (!failure && results.length === 0) fail(new UploadError(400, "no_files"));
  if (failure) {
    await Promise.allSettled(stored.map((key) => storage.delete(key)));
    const mapped = toUploadError(failure);
    if (mapped) throw mapped;
    throw failure;
  }
  results.sort((a, b) => a.index - b.index);
  return { files: results, fields };
}
