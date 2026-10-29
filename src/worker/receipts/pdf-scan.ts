/**
 * Inventarul imaginilor unui PDF pe octeții bruți: DOAR o verificare rapidă („fail-fast”),
 * FAIL-CLOSED, înaintea procesului copil (ADR 0013; revizuirile de securitate F6-A). NU e
 * controlul de securitate: acela e procesul copil limitat de sistem (`pdf-sandbox.ts`), pentru
 * că un parser de regex nu poate reproduce exact parserul pdf.js (diferențe de interpretare).
 * De aceea, tot ce nu se poate dimensiona POZITIV și fără ambiguitate e refuzat aici:
 *
 * - nume cu escape `#xx` care, decodate, sunt chei/valori relevante (de exemplu `/Wid#74h`,
 *   `/Im#61ge`);
 * - fluxuri de obiecte (`/Type /ObjStm`) într-un PDF cu imagini;
 * - în dicționarul unei imagini: cheile abreviate `/W`, `/H` (forma imaginilor inline), mai
 *   multe `/Width` sau `/Height`, valori neîntregi; o valoare indirectă (`/Height 5 0 R`, produsă
 *   de multe aplicații: Quartz, Skia, scanere) e acceptată DOAR dacă în text există exact O
 *   definiție a obiectului cu acel număr, de forma `N G obj <întreg direct 1–9 cifre> endobj`
 *   (fără flux, fără altă definiție a aceluiași număr — actualizări incrementale, dubluri —, fără
 *   referințe în lanț); orice altceva → refuz;
 * - orice `/Subtype /Image` care nu ține de un obiect `N G obj … stream` delimitat (potrivirea
 *   nu trece peste `endobj`);
 * - imagini inline (`BI … ID`) vizibile în conținutul necomprimat;
 * - peste plafon: pixeli pe imagine, pixeli însumați, număr de imagini.
 * Conținutul fluxurilor (`stream … endstream`) e exclus din analiză (date binare).
 * Imaginile inline din fluxuri COMPRIMATE nu se văd aici: le oprește procesul copil.
 */

export type PdfImageInfo = Readonly<{ width: number; height: number }>;

export type PdfScanLimits = Readonly<{
  maxImagePixels: number;
  maxTotalPixels: number;
  maxImages: number;
}>;

export type PdfScanRejection = "image_too_large" | "pdf_image_unverifiable" | "pdf_too_complex";

export class PdfScanError extends Error {
  constructor(readonly code: PdfScanRejection) {
    super("PDF-ul nu e acceptat.");
    this.name = "PdfScanError";
  }
}

/** Numele care decid ce e imagine și cât de mare e (cheile imaginilor inline incluse). */
const SENSITIVE_NAMES = new Set([
  "Type",
  "Subtype",
  "Image",
  "XObject",
  "ObjStm",
  "Width",
  "Height",
  "W",
  "H",
  "BitsPerComponent",
  "BPC",
  "Filter",
  "F",
  "DecodeParms",
  "DP",
  "Length",
]);

const unverifiable = () => new PdfScanError("pdf_image_unverifiable");

/**
 * Textul structural: octeții în latin1, cu conținutul fiecărui flux înlocuit de un marcaj
 * (`stream␠endstream`), ca datele binare să nu producă potriviri false.
 */
function structuralText(input: Uint8Array): string {
  const text = Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("latin1");
  return text.replace(/\bstream\r?\n[\s\S]*?\bendstream\b/g, "stream endstream");
}

const DELIMITED_IMAGE_OBJECT = /\d+\s+\d+\s+obj\b((?:(?!\bendobj\b)[\s\S])*?)\bstream endstream/g;

/** Un întreg zecimal de 1–9 cifre → număr ≥ 1, altfel refuz. */
function positiveInteger(digits: string): number {
  const value = Number(digits);
  if (!Number.isSafeInteger(value) || value < 1) throw unverifiable();
  return value;
}

/**
 * Valoarea obiectului indirect `N G` DOAR dacă e neambiguă: în tot textul structural există o
 * singură definiție `N <orice> obj` a numărului N, are generația G și conține exact un întreg
 * direct (`N G obj 1234 endobj`). Un flux (`stream`), o referință (`M 0 R`, deci și un ciclu),
 * un număr neîntreg, mai multe definiții (actualizări incrementale) sau lipsa definiției → refuz.
 */
function resolveIndirectInteger(text: string, objectNumber: string, generation: string): number {
  const n = String(Number(objectNumber));
  const definitions = [
    ...text.matchAll(new RegExp(`(?<![0-9])0*${n}\\s+(\\d{1,5})\\s+obj\\b`, "g")),
  ];
  if (definitions.length !== 1) throw unverifiable();
  const definition = definitions[0]!;
  if (Number(definition[1]) !== Number(generation)) throw unverifiable();
  const body = /^\s+(\d{1,9})\s+endobj\b/.exec(
    text.slice(definition.index! + definition[0].length),
  );
  if (!body) throw unverifiable();
  return positiveInteger(body[1]!);
}

function onlyDirectInteger(text: string, dict: string, key: "Width" | "Height"): number {
  const all = [...dict.matchAll(new RegExp(`/${key}(?![A-Za-z0-9])`, "g"))];
  if (all.length !== 1) throw unverifiable();
  const match = new RegExp(
    `/${key}\\s+(\\d{1,9})(?![\\d.])(?:\\s+(\\d{1,5})\\s+R(?![A-Za-z0-9]))?`,
  ).exec(dict);
  if (!match) throw unverifiable();
  // Referință indirectă: rezolvată doar fără ambiguitate (vezi `resolveIndirectInteger`).
  if (match[2] !== undefined) return resolveIndirectInteger(text, match[1]!, match[2]);
  // Un număr direct urmat de altceva decât `G R` (de exemplu `10 0` fără R) rămâne valoarea.
  return positiveInteger(match[1]!);
}

/** Imaginile declarate, cu regulile de mai sus (fără nicio decodare). */
export function scanPdfImages(input: Uint8Array, limits: PdfScanLimits): PdfImageInfo[] {
  const text = structuralText(input);
  // Un nume cu escape care, decodat, e o cheie sau o valoare relevantă → refuz (fontele cu
  // `#20` în nume, frecvente în bonurile electronice, rămân acceptate).
  for (const [name] of text.matchAll(/\/[^\s/<>[\]()%{}]*#[0-9A-Fa-f]{2}[^\s/<>[\]()%{}]*/g)) {
    const decoded = name
      .slice(1)
      .replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
    if (SENSITIVE_NAMES.has(decoded)) throw unverifiable();
  }
  if (/(^|[\s\]>])BI\s+\/(?:W|H|Width|Height|BPC|CS)\b/.test(text)) throw unverifiable();
  const declared = [...text.matchAll(/\/Subtype\s*\/Image(?![A-Za-z0-9])/g)].length;
  if (declared > 0 && /\/Type\s*\/ObjStm(?![A-Za-z0-9])/.test(text)) throw unverifiable();

  const images: PdfImageInfo[] = [];
  let total = 0;
  for (const match of text.matchAll(DELIMITED_IMAGE_OBJECT)) {
    const dict = match[1]!;
    if (!/\/Subtype\s*\/Image(?![A-Za-z0-9])/.test(dict)) continue;
    // Cheile abreviate ale imaginilor inline nu au ce căuta într-un XObject.
    if (/\/(?:W|H)(?![A-Za-z0-9])/.test(dict)) throw unverifiable();
    const width = onlyDirectInteger(text, dict, "Width");
    const height = onlyDirectInteger(text, dict, "Height");
    const pixels = width * height;
    if (pixels > limits.maxImagePixels) throw new PdfScanError("image_too_large");
    total += pixels;
    if (total > limits.maxTotalPixels) throw new PdfScanError("image_too_large");
    images.push({ width, height });
    if (images.length > limits.maxImages) throw new PdfScanError("pdf_too_complex");
  }
  if (declared !== images.length) throw unverifiable();
  return images;
}
