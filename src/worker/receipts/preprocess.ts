import sharp, { type Sharp } from "sharp";

import {
  type AcceptedMime,
  ContentRejectedError,
  type ImageMime,
  validateHead,
} from "@/modules/documents/content";

import { PdfScanError, scanPdfImages } from "./pdf-scan";
import { PDF_CHILD_LIMITS, PdfChildError, readPdfInChild } from "./pdf-sandbox";

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
 * PDF (unpdf = pdf.js fără canvas): ÎNAINTE de orice decodare, dimensiunile imaginilor declarate
 * se citesc din octeții bruți (`pdf-scan.ts`) și se aplică plafoanele (pe imagine și însumat);
 * (doar fail-fast, fail-closed); apoi pdf.js rulează într-un PROCES COPIL limitat de sistem
 * (`prlimit`: adrese, CPU, fără fișiere) și ucis cu SIGKILL la timeout (`pdf-sandbox.ts`;
 * acesta e controlul real): numărul de pagini (plafon), textul pe pagini; dacă PDF-ul nu are text
 * (scanat), imaginea cea mai mare de pe fiecare pagină e extrasă (fără randare, deci fără
 * `@napi-rs/canvas`), redimensionată și comprimată JPEG ÎN COPIL (părintele primește cel mult
 * 32 MB în total), apoi trece prin același traseu ca o poză. Un PDF fără text și fără imagini
 * (desene vectoriale) e respins cu `pdf_no_content`.
 *
 * Timpul: un termen (`deadline`) pentru tot documentul, verificat între pași; sharp primește
 * `timeout` (libvips oprește singur procesarea), procesul copil PDF e ucis. Nicio muncă nu rămâne
 * în fundal după ce funcția a întors eroarea (revizuirea de securitate F6-A, M2).
 *
 * Erorile devin `PreprocessError` cu un cod stabil, fără ecou din conținut.
 */

export type PreprocessLimits = Readonly<{
  maxImagePixels: number;
  maxPdfPages: number;
  /** Timpul maxim pentru tot documentul. */
  timeoutMs: number;
  /** Doar teste: alt script pentru procesul copil PDF (de exemplu unul ostil). */
  pdfChildScript?: string;
}>;

export const DEFAULT_PREPROCESS_TIMEOUT_MS = 60_000;
/** Latura lungă maximă după redimensionare. */
export const MAX_SIDE_PX = 2048;
/** Sub atâtea litere/cifre, un PDF e tratat ca scanat. */
export const MIN_PDF_TEXT_CHARS = 20;
/** O imagine dintr-un PDF: cel mult 25 MP (o pagină A4 la 600 dpi are ~35 MP; 300 dpi ~9 MP). */
export const MAX_PDF_IMAGE_PIXELS = 25_000_000;
const JPEG_QUALITY = 85;

export type PreprocessErrorCode =
  | ContentRejectedError["reason"]
  | "mime_mismatch"
  | "too_many_pages"
  | "pdf_invalid"
  | "pdf_encrypted"
  | "pdf_no_content"
  | "pdf_image_unverifiable"
  | "pdf_too_complex"
  | "pdf_sandbox_unavailable"
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

function sharpInput(input: Buffer, limits: PreprocessLimits, deadline: number) {
  const seconds = Math.ceil((deadline - Date.now()) / 1000);
  if (seconds <= 0) throw new PreprocessError("preprocess_timeout");
  return sharp(input, {
    limitInputPixels: limits.maxImagePixels,
    failOn: "error",
    sequentialRead: true,
  }).timeout({ seconds });
}

function checkDeadline(deadline: number): void {
  if (Date.now() >= deadline) throw new PreprocessError("preprocess_timeout");
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

async function prepare(pipeline: Sharp, deadline: number): Promise<PreparedImage> {
  const { data, info } = await pipeline
    .rotate() // după orientarea EXIF; apoi metadatele nu se mai copiază în ieșire
    .resize({ width: MAX_SIDE_PX, height: MAX_SIDE_PX, fit: "inside", withoutEnlargement: true })
    .normalise()
    .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: "4:2:0" })
    .toBuffer({ resolveWithObject: true });
  checkDeadline(deadline);
  return { jpeg: data, width: info.width, height: info.height, dhash: await dHash(data) };
}

/** O imagine (JPEG/PNG/WebP) → JPEG curat. */
export async function preprocessImage(
  input: Buffer,
  mime: ImageMime,
  limits: PreprocessLimits,
  deadline: number = Date.now() + limits.timeoutMs,
): Promise<PreparedImage> {
  let format: string | undefined;
  try {
    // `metadata()` citește doar antetul (fără decodare); `limitInputPixels` refuză bombele.
    format = (await sharpInput(input, limits, deadline).metadata()).format;
  } catch (error) {
    throw mapSharpError(error);
  }
  // Decodorul trebuie să confirme tipul detectat după octeți (apărare contra poligloților).
  if (format !== SHARP_FORMAT[mime]) throw new PreprocessError("mime_mismatch");
  try {
    return await prepare(sharpInput(input, limits, deadline), deadline);
  } catch (error) {
    throw mapSharpError(error);
  }
}

function mapSharpError(error: unknown): PreprocessError {
  if (error instanceof PreprocessError) return error;
  const message = error instanceof Error ? error.message : "";
  // Mesajul libvips nu se propagă (poate conține detalii); doar codul.
  if (/pixel limit/i.test(message)) return new PreprocessError("image_too_large");
  if (/timeout/i.test(message)) return new PreprocessError("preprocess_timeout");
  return new PreprocessError("invalid_image");
}

async function preprocessPdf(
  input: Buffer,
  limits: PreprocessLimits,
  deadline: number,
): Promise<Preprocessed> {
  // 1. Dimensiunile imaginilor, fără decodare (bombele sunt refuzate înainte de pdf.js).
  const perImage = Math.min(limits.maxImagePixels, MAX_PDF_IMAGE_PIXELS);
  try {
    scanPdfImages(input, {
      maxImagePixels: perImage,
      maxTotalPixels: 2 * limits.maxImagePixels,
      maxImages: limits.maxPdfPages * PDF_CHILD_LIMITS.maxImagesPerPage,
    });
  } catch (error) {
    if (error instanceof PdfScanError) throw new PreprocessError(error.code);
    throw error;
  }
  // 2. pdf.js în procesul copil limitat (ucis la termen).
  let read;
  try {
    read = await readPdfInChild(input, {
      maxPages: limits.maxPdfPages,
      minTextChars: MIN_PDF_TEXT_CHARS,
      deadline,
      maxImagePixels: perImage,
      maxTotalPixels: 2 * limits.maxImagePixels,
      ...(limits.pdfChildScript ? { childScript: limits.pdfChildScript } : {}),
    });
  } catch (error) {
    if (error instanceof PdfChildError) throw new PreprocessError(error.code);
    throw error;
  }
  if (read.images === null) return { kind: "text", pages: read.pages, text: read.text };

  // 3. Scanat: copilul a trimis deja JPEG-uri mici (≤ 2048 px); trec prin același traseu ca o
  // poză (sharp re-verifică tipul și pixelii).
  const images: PreparedImage[] = [];
  for (const image of read.images) {
    try {
      images.push(await prepare(sharpInput(image.jpeg, limits, deadline), deadline));
    } catch (error) {
      throw mapSharpError(error);
    }
  }
  if (images.length === 0) throw new PreprocessError("pdf_no_content");
  return { kind: "images", pages: read.pages, images };
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
  const deadline = Date.now() + limits.timeoutMs;
  if (mime === "application/pdf") return preprocessPdf(input, limits, deadline);
  const image = await preprocessImage(input, mime, limits, deadline);
  return { kind: "images", pages: 1, images: [image] };
}
