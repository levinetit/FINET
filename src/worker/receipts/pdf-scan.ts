/**
 * Inventarul imaginilor unui PDF citit din octeții bruți, FĂRĂ decodare (revizuirea de securitate
 * F6-A, M1): dimensiunile fiecărei imagini (`/Subtype /Image`, `/Width`, `/Height`) se verifică
 * ÎNAINTE ca pdf.js să decodeze ceva, ca o „bombă” de decompresie (o imagine declarată uriaș,
 * comprimată în câțiva KB) să fie refuzată fără a aloca memoria.
 *
 * De ce merge pe octeții bruți: imaginile XObject sunt obiecte-flux, iar specificația PDF
 * (ISO 32000, 7.5.7) interzice fluxurile în fluxurile de obiecte comprimate, deci dicționarul
 * fiecărei imagini e mereu text necomprimat în fișier, imediat înaintea cuvântului `stream`.
 * Regula de prudență (decizia mea, ADR 0013): orice imagine ale cărei dimensiuni nu pot fi
 * citite direct (de exemplu `/Width 5 0 R`, referință indirectă) sau orice apariție a lui
 * `/Subtype /Image` în afara unui dicționar de flux recunoscut → refuz (`pdf_image_unverifiable`).
 * Imaginile inline (`BI … ID … EI`) din fluxurile de conținut comprimate nu se văd aici; ele
 * sunt limitate de heap-ul firului izolat și de timeout (`pdf-worker.ts`).
 */

export type PdfImageInfo = Readonly<{ width: number; height: number }>;

export type PdfScanLimits = Readonly<{
  /** Pixeli maximi pe o imagine din PDF. */
  maxImagePixels: number;
  /** Pixeli maximi însumați pe tot documentul. */
  maxTotalPixels: number;
}>;

export type PdfScanRejection = "image_too_large" | "pdf_image_unverifiable";

export class PdfScanError extends Error {
  constructor(readonly code: PdfScanRejection) {
    super("PDF-ul nu e acceptat.");
    this.name = "PdfScanError";
  }
}

// Dicționarul unui obiect-flux: `N G obj << … >> stream` (non-lacom: până la `>>` dinaintea
// cuvântului `stream`, adică sfârșitul dicționarului exterior, chiar cu dicționare imbricate).
const STREAM_OBJECT = /\d+\s+\d+\s+obj\s*<<([\s\S]*?)>>\s*stream\b/g;
const IMAGE_SUBTYPE = /\/Subtype\s*\/Image\b/g;

function dimension(dict: string, name: "Width" | "Height"): number {
  const match = new RegExp(`/${name}\\s+(\\d{1,9})(\\s+\\d+\\s+R)?\\b`).exec(dict);
  if (!match || match[2]) throw new PdfScanError("pdf_image_unverifiable");
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 1) throw new PdfScanError("pdf_image_unverifiable");
  return value;
}

/** Imaginile declarate în PDF, cu plafoanele aplicate (fără nicio decodare). */
export function scanPdfImages(input: Uint8Array, limits: PdfScanLimits): PdfImageInfo[] {
  const text = Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("latin1");
  const images: PdfImageInfo[] = [];
  let total = 0;
  for (const match of text.matchAll(STREAM_OBJECT)) {
    const dict = match[1]!;
    if (!/\/Subtype\s*\/Image\b/.test(dict)) continue;
    const width = dimension(dict, "Width");
    const height = dimension(dict, "Height");
    const pixels = width * height;
    if (pixels > limits.maxImagePixels) throw new PdfScanError("image_too_large");
    total += pixels;
    if (total > limits.maxTotalPixels) throw new PdfScanError("image_too_large");
    images.push({ width, height });
  }
  // O imagine pe care nu am putut-o lega de un dicționar de flux nu se lasă la decodare.
  const declared = [...text.matchAll(IMAGE_SUBTYPE)].length;
  if (declared !== images.length) throw new PdfScanError("pdf_image_unverifiable");
  return images;
}
