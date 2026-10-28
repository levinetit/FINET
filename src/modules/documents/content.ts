/**
 * Validarea fișierelor încărcate DUPĂ CONȚINUT (master prompt 6.3; ADR 0013), fără dependențe:
 * o folosesc atât serverul web (la încărcare, pe primii octeți), cât și workerul (înainte de
 * preprocesare, pe tot fișierul). Extensia și tipul declarat de client nu decid nimic.
 *
 * Acceptate: JPEG, PNG, WebP, PDF. Refuzate cu cod stabil: HEIC/HEIF/AVIF (decizia 4: `sharp`
 * prebuilt nu decodează HEVC; aplicația Android convertește pe telefon), SVG, HTML, XML,
 * executabile și orice altceva. Mesajele nu repetă nimic din conținut.
 */

export const ACCEPTED_MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export type AcceptedMime = (typeof ACCEPTED_MIMES)[number];
export type ImageMime = Exclude<AcceptedMime, "application/pdf">;

/** Motivele stabile de refuz (`documents.error_code` / `reason` în API). */
export type ContentRejection =
  | "empty_file"
  | "unsupported_type"
  | "heic_unsupported"
  | "markup_content"
  | "invalid_image"
  | "image_too_large";

export class ContentRejectedError extends Error {
  constructor(readonly reason: ContentRejection) {
    super("Fișierul nu e acceptat.");
    this.name = "ContentRejectedError";
  }
}

/** Câți octeți de la început sunt citiți pentru tip și dimensiuni (EXIF poate avea 64 KB). */
export const HEAD_BYTES = 256 * 1024;
/** Fereastra în care se caută marcaje HTML/SVG/XML (fișiere „poliglot”). */
const MARKUP_WINDOW = 1024;

const startsWith = (b: Uint8Array, sig: readonly number[], offset = 0): boolean =>
  b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v);
const ascii = (b: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...b.subarray(offset, offset + length));

// Mărcile `ftyp` ale familiei HEIF (HEIC, HEIF, AVIF): refuzate explicit, cu mesaj dedicat.
const HEIF_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
  "avif",
  "avis",
]);

/** Tipul după primii octeți, sau motivul refuzului. Semnăturile trebuie să fie la offset 0. */
export function sniffMime(head: Uint8Array): AcceptedMime {
  if (head.length === 0) throw new ContentRejectedError("empty_file");
  let mime: AcceptedMime | null = null;
  if (startsWith(head, [0xff, 0xd8, 0xff])) mime = "image/jpeg";
  else if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) mime = "image/png";
  else if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") mime = "image/webp";
  else if (ascii(head, 0, 5) === "%PDF-") mime = "application/pdf";
  else if (ascii(head, 4, 4) === "ftyp" && HEIF_BRANDS.has(ascii(head, 8, 4))) {
    throw new ContentRejectedError("heic_unsupported");
  }
  if (!mime) throw new ContentRejectedError("unsupported_type");
  // Un fișier cu semnătură validă, dar cu marcaje HTML/SVG/XML la început (poliglot), e refuzat:
  // nu are ce căuta pe un bon, iar un browser l-ar putea interpreta ca pagină.
  // La PDF, `<?xml`/`<svg` pot apărea legitim (metadate XMP), deci acolo se caută doar HTML.
  const window = ascii(head, 0, Math.min(head.length, MARKUP_WINDOW)).toLowerCase();
  const markup =
    mime === "application/pdf"
      ? /<(?:!doctype|html|head|body|script|iframe)\b/
      : /<(?:!doctype|html|head|body|script|svg|iframe|object|embed)\b|<\?xml/;
  if (markup.test(window)) {
    throw new ContentRejectedError("markup_content");
  }
  return mime;
}

export type ImageSize = Readonly<{ width: number; height: number }>;

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const u32be = (b: Uint8Array, o: number) =>
  ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;

function jpegSize(b: Uint8Array): ImageSize | null {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1]!;
    if (marker === 0xff) {
      o += 1; // octet de umplere
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    const length = u16be(b, o + 2);
    if (length < 2) return null;
    // SOF0..SOF15, fără DHT (C4), JPG (C8), DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, o + 5), width: u16be(b, o + 7) };
    }
    if (marker === 0xda || marker === 0xd9) return null; // datele au început fără SOF
    o += 2 + length;
  }
  return null;
}

function pngSize(b: Uint8Array): ImageSize | null {
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function webpSize(b: Uint8Array): ImageSize | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (chunk === "VP8 ") {
    if (!(b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/**
 * Dimensiunile din antetul imaginii (fără decodare), ca o „bombă” de decompresie (de exemplu
 * 30000 × 30000 într-un PNG de câțiva KB) să fie refuzată înainte de stocare și de sharp.
 */
export function imageSize(head: Uint8Array, mime: ImageMime): ImageSize {
  const size =
    mime === "image/jpeg" ? jpegSize(head) : mime === "image/png" ? pngSize(head) : webpSize(head);
  if (!size || size.width < 1 || size.height < 1) throw new ContentRejectedError("invalid_image");
  return size;
}

/** Tipul + (pentru imagini) verificarea dimensiunilor față de plafonul de pixeli. */
export function validateHead(
  head: Uint8Array,
  limits: Readonly<{ maxImagePixels: number }>,
): Readonly<{ mime: AcceptedMime; size: ImageSize | null }> {
  const mime = sniffMime(head);
  if (mime === "application/pdf") return { mime, size: null };
  const size = imageSize(head, mime);
  if (size.width * size.height > limits.maxImagePixels) {
    throw new ContentRejectedError("image_too_large");
  }
  return { mime, size };
}
