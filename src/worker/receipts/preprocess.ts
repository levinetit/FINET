import sharp from "sharp";
import { extractImages, extractText, getDocumentProxy } from "unpdf";

import {
  type AcceptedMime,
  ContentRejectedError,
  type ImageMime,
  validateHead,
} from "@/modules/documents/content";

/**
 * Preprocesarea documentelor în WORKER (Faza 6; master prompt 3.6, 6.3; ADR 0013). Rezultatul
 * stă doar în memorie (nu se scrie pe disc): workerul are storage-ul doar pentru citire.
 *
 * Imagini (sharp): verificarea tipului real (decodorul trebuie să confirme tipul detectat după
 * octeți), rotirea după EXIF, ELIMINAREA tuturor metadatelor (EXIF, GPS, ICC, XMP: sharp nu
 * păstrează nimic fără `keepMetadata`/`withMetadata`), redimensionarea la cel mult 2048 px pe
 * latura lungă, normalizarea contrastului, re-encodarea JPEG (re-encodarea elimină orice
 * conținut străin atașat imaginii). Plus dHash pe 64 de biți pentru „poză aproape identică”.
 *
 * PDF (unpdf = pdf.js fără canvas): numărul de pagini (plafon), textul pe pagini; dacă PDF-ul
 * nu are text (scanat), imaginea cea mai mare de pe fiecare pagină e extrasă (fără randare, deci
 * fără `@napi-rs/canvas`) și trece prin același traseu ca o poză. Un PDF fără text și fără
 * imagini (desene vectoriale) e respins cu `pdf_no_content`.
 *
 * Erorile devin `PreprocessError` cu un cod stabil, fără ecou din conținut.
 */

export type PreprocessLimits = Readonly<{
  maxImagePixels: number;
  maxPdfPages: number;
  /** Timpul maxim pentru tot documentul. */
  timeoutMs: number;
}>;

export const DEFAULT_PREPROCESS_TIMEOUT_MS = 60_000;
/** Latura lungă maximă după redimensionare. */
export const MAX_SIDE_PX = 2048;
/** Sub atâtea litere/cifre, un PDF e tratat ca scanat. */
export const MIN_PDF_TEXT_CHARS = 20;
const JPEG_QUALITY = 85;

export type PreprocessErrorCode =
  | ContentRejectedError["reason"]
  | "mime_mismatch"
  | "too_many_pages"
  | "pdf_invalid"
  | "pdf_encrypted"
  | "pdf_no_content"
  | "preprocess_timeout";

export class PreprocessError extends Error {
  constructor(readonly code: PreprocessErrorCode) {
    super("Documentul nu a putut fi preprocesat.");
    this.name = "PreprocessError";
  }
}

export type PreparedImage = Readonly<{
  /** JPEG fără metadate, gata de trimis la modelul vision. */
  jpeg: Buffer;
  width: number;
  height: number;
  /** dHash pe 64 de biți, ca `bigint` cu semn (coloana `perceptual_hash`). */
  dhash: bigint;
}>;

export type Preprocessed =
  | Readonly<{ kind: "images"; pages: number; images: readonly PreparedImage[] }>
  | Readonly<{ kind: "text"; pages: number; text: readonly string[] }>;

// Workerul are 384 MB: fără cache libvips și un singur fir (decizia mea, ADR 0013).
sharp.cache(false);
sharp.concurrency(1);

function sharpInput(
  input: Buffer,
  limits: PreprocessLimits,
  raw?: Readonly<{ width: number; height: number; channels: 1 | 2 | 3 | 4 }>,
) {
  return sharp(input, {
    limitInputPixels: limits.maxImagePixels,
    failOn: "error",
    sequentialRead: true,
    ...(raw ? { raw } : {}),
  });
}

/** dHash: 9×8 tonuri de gri, câte un bit pe comparația pixelilor vecini de pe rând. */
export async function dHash(image: Buffer): Promise<bigint> {
  const pixels = await sharp(image)
    .greyscale()
    .resize(9, 8, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer();
  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      hash = (hash << 1n) | (pixels[y * 9 + x]! > pixels[y * 9 + x + 1]! ? 1n : 0n);
    }
  }
  return BigInt.asIntN(64, hash);
}

/** Distanța Hamming între două dHash-uri. */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = BigInt.asUintN(64, a ^ b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

const SHARP_FORMAT: Readonly<Record<ImageMime, string>> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

async function prepare(pipeline: sharp.Sharp): Promise<PreparedImage> {
  const { data, info } = await pipeline
    .rotate() // după orientarea EXIF; apoi metadatele nu se mai copiază în ieșire
    .resize({ width: MAX_SIDE_PX, height: MAX_SIDE_PX, fit: "inside", withoutEnlargement: true })
    .normalise()
    .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: "4:2:0" })
    .toBuffer({ resolveWithObject: true });
  return { jpeg: data, width: info.width, height: info.height, dhash: await dHash(data) };
}

/** O imagine (JPEG/PNG/WebP) → JPEG curat. */
export async function preprocessImage(
  input: Buffer,
  mime: ImageMime,
  limits: PreprocessLimits,
): Promise<PreparedImage> {
  let format: string | undefined;
  try {
    format = (await sharpInput(input, limits).metadata()).format;
  } catch (error) {
    throw mapSharpError(error);
  }
  // Decodorul trebuie să confirme tipul detectat după octeți (apărare contra poligloților).
  if (format !== SHARP_FORMAT[mime]) throw new PreprocessError("mime_mismatch");
  try {
    return await prepare(sharpInput(input, limits));
  } catch (error) {
    throw mapSharpError(error);
  }
}

function mapSharpError(error: unknown): PreprocessError {
  if (error instanceof PreprocessError) return error;
  const message = error instanceof Error ? error.message : "";
  // Mesajul libvips nu se propagă (poate conține detalii); doar codul.
  if (/pixel limit/i.test(message)) return new PreprocessError("image_too_large");
  return new PreprocessError("invalid_image");
}

async function preprocessPdf(input: Buffer, limits: PreprocessLimits): Promise<Preprocessed> {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(input), {
      // Fără fonturi de sistem, fără evaluare de cod, fără resurse externe.
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      stopAtErrors: true,
    });
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === "PasswordException") throw new PreprocessError("pdf_encrypted");
    throw new PreprocessError("pdf_invalid");
  }
  try {
    const pages = pdf.numPages;
    if (pages < 1) throw new PreprocessError("pdf_invalid");
    if (pages > limits.maxPdfPages) throw new PreprocessError("too_many_pages");
    let text: string[];
    try {
      text = (await extractText(pdf, { mergePages: false })).text.map((t) => t.trim());
    } catch {
      throw new PreprocessError("pdf_invalid");
    }
    const significant = text.join("").replace(/[^\p{L}\p{N}]/gu, "").length;
    if (significant >= MIN_PDF_TEXT_CHARS) return { kind: "text", pages, text };

    // Scanat: imaginea cea mai mare de pe fiecare pagină.
    const images: PreparedImage[] = [];
    for (let page = 1; page <= pages; page++) {
      let extracted;
      try {
        extracted = await extractImages(pdf, page);
      } catch {
        throw new PreprocessError("pdf_invalid");
      }
      const largest = extracted.sort((a, b) => b.width * b.height - a.width * a.height)[0];
      if (!largest) continue;
      if (largest.width * largest.height > limits.maxImagePixels) {
        throw new PreprocessError("image_too_large");
      }
      try {
        images.push(
          await prepare(
            sharpInput(
              Buffer.from(largest.data.buffer, largest.data.byteOffset, largest.data.byteLength),
              limits,
              {
                width: largest.width,
                height: largest.height,
                channels: largest.channels,
              },
            ),
          ),
        );
      } catch (error) {
        throw mapSharpError(error);
      }
    }
    if (images.length === 0) throw new PreprocessError("pdf_no_content");
    return { kind: "images", pages, images };
  } finally {
    // Eliberează memoria pdf.js (sarcina de încărcare; `destroy` nu e expus pe proxy în unpdf).
    const handle = pdf as unknown as {
      destroy?: () => Promise<void>;
      loadingTask?: { destroy?: () => Promise<void> };
    };
    await Promise.resolve(handle.destroy?.() ?? handle.loadingTask?.destroy?.()).catch(() => {});
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PreprocessError("preprocess_timeout")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Preprocesează un document întreg. `detectedMime` e tipul salvat la încărcare; conținutul e
 * re-validat aici (fișierul putea fi înlocuit pe disc între timp).
 */
export async function preprocessDocument(
  input: Buffer,
  detectedMime: AcceptedMime,
  limits: PreprocessLimits,
): Promise<Preprocessed> {
  let mime: AcceptedMime;
  try {
    mime = validateHead(input.subarray(0, 256 * 1024), limits).mime;
  } catch (error) {
    if (error instanceof ContentRejectedError) throw new PreprocessError(error.reason);
    throw error;
  }
  if (mime !== detectedMime) throw new PreprocessError("mime_mismatch");
  const work =
    mime === "application/pdf"
      ? preprocessPdf(input, limits)
      : preprocessImage(input, mime, limits).then((image): Preprocessed => ({
          kind: "images",
          pages: 1,
          images: [image],
        }));
  return withTimeout(work, limits.timeoutMs);
}
