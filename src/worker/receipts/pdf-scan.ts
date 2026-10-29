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
function latin1Of(input: Uint8Array): string {
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("latin1");
}

function structuralText(text: string): string {
  return text.replace(/\bstream\r?\n[\s\S]*?\bendstream\b/g, "stream endstream");
}

const DELIMITED_IMAGE_OBJECT = /\d+\s+\d+\s+obj\b((?:(?!\bendobj\b)[\s\S])*?)\bstream endstream/g;

/** Un întreg zecimal de 1–9 cifre → număr ≥ 1, altfel refuz. */
function positiveInteger(digits: string): number {
  const value = Number(digits);
  if (!Number.isSafeInteger(value) || value < 1) throw unverifiable();
  return value;
}

/** Spațiile albe PDF (ISO 32000-1, 7.2.2): NUL, TAB, LF, FF, CR, SPACE. Nimic altceva. */
const WS = "[\\x00\\t\\n\\f\\r ]";
const NOT_REGULAR_AFTER = "(?![A-Za-z0-9])";
/** După o valoare: spațiu alb PDF, delimitator sau sfârșit (altfel tokenul continuă, de exemplu NBSP). */
const DELIMITER_AFTER = "(?=[\\x00\\t\\n\\f\\r /<>\\[\\]()%{}]|$)";

/**
 * Verificările globale cerute ÎNAINTE de a rezolva o referință indirectă (fail-closed; doar pentru
 * PDF-urile care chiar au dimensiuni indirecte, ca acceptarea celor cu valori directe să nu se
 * schimbe):
 * - o singură secțiune `startxref`/`xref`/`trailer` și fără `/Prev` (fără actualizări
 *   incrementale, unde pdf.js ar alege ultima definiție);
 * - fiecare token `obj` (nu `endobj`) e parte dintr-o definiție strictă `N G obj`, cu spații albe
 *   PDF între componente (un `obj` „liber” poate fi interpretat altfel de pdf.js);
 * - comentariile `%` nu conțin cuvinte structurale (`obj`, `xref`, `trailer`, `stream`, `Width`,
 *   `Height`, `Prev`, `Length`); dicționarul imaginii cu referința nu conține deloc `%`, iar corpul
 *   obiectului referit e strict (deci fără comentarii).
 */
function assertResolvableStructure(text: string): void {
  const count = (re: RegExp) => [...text.matchAll(re)].length;
  if (count(/startxref/g) !== 1) throw unverifiable();
  if (count(/(?<![A-Za-z])xref(?![A-Za-z0-9])/g) !== 1) throw unverifiable();
  if (count(/(?<![A-Za-z])trailer(?![A-Za-z0-9])/g) !== 1) throw unverifiable();
  if (/\/Prev(?![A-Za-z0-9])/.test(text)) throw unverifiable();
  const tokens = count(/(?<![A-Za-z0-9])obj(?![A-Za-z0-9])/g);
  const strict = count(
    new RegExp(`(?<![0-9A-Za-z])\\d{1,10}${WS}+\\d{1,5}${WS}+obj${NOT_REGULAR_AFTER}`, "g"),
  );
  if (tokens !== strict) throw unverifiable();
  // Comentariile: permise (de exemplu `%PDF-1.4`, markerul binar, o linie a producătorului,
  // `%%EOF`), dar NU dacă pomenesc cuvinte structurale: un `N G obj`, `xref` sau `/Height` dintr-un
  // comentariu e ignorat de pdf.js, dar l-ar număra o expresie regulată (diferență de parser).
  for (const m of text.matchAll(/%[^\r\n]*/g)) {
    if (/obj|xref|trailer|stream|Width|Height|Prev|Length/.test(m[0])) throw unverifiable();
  }
}

/** Intrările tabelului `xref` clasic (un singur tabel), parsate strict: număr → offset. */
function xrefOffsets(raw: string): Map<number, { offset: number; generation: number }> {
  const at = /(?:^|[\r\n])xref[\r\n]+/.exec(raw);
  if (!at) throw unverifiable();
  let pos = at.index + at[0].length;
  const out = new Map<number, { offset: number; generation: number }>();
  const header = /(\d{1,10}) (\d{1,10})[\r\n]+/y;
  for (let sections = 0; sections < 1000; sections++) {
    header.lastIndex = pos;
    const h = header.exec(raw);
    if (!h) break;
    pos = header.lastIndex;
    const first = Number(h[1]);
    const n = Number(h[2]);
    if (n > 100_000) throw unverifiable();
    for (let i = 0; i < n; i++) {
      const entry = /^(\d{10}) (\d{5}) ([nf])(?: \r| \n|\r\n)/.exec(raw.slice(pos, pos + 20));
      if (!entry) throw unverifiable();
      pos += 20;
      if (entry[3] === "n") {
        if (out.has(first + i)) throw unverifiable();
        out.set(first + i, { offset: Number(entry[1]), generation: Number(entry[2]) });
      }
    }
  }
  if (!/^[\x00\t\n\f\r ]*trailer/.test(raw.slice(pos, pos + 64))) throw unverifiable();
  return out;
}

/**
 * Valoarea obiectului indirect `N G` DOAR dacă e neambiguă (fail-closed; scanul rămâne
 * „fail-fast”, controlul real e procesul copil):
 * - structura globală e simplă (`assertResolvableStructure`);
 * - în textul structural există o singură definiție a numărului N, cu generația G;
 * - tabelul `xref` (unul singur, parsat strict) indică EXACT offsetul acestei definiții în octeții
 *   bruți (ca pdf.js să citească același obiect);
 * - corpul e exact `N G obj <întreg direct de 1–9 cifre> endobj`, cu spații albe PDF (fără
 *   comentarii, flux, dicționar, referință sau ciclu).
 */
function resolveIndirectInteger(
  raw: string,
  text: string,
  objectNumber: string,
  generation: string,
): number {
  assertResolvableStructure(text);
  const n = Number(objectNumber);
  const g = Number(generation);
  const definition = new RegExp(
    `(?<![0-9A-Za-z])0*${n}${WS}+(\\d{1,5})${WS}+obj${NOT_REGULAR_AFTER}`,
    "g",
  );
  const definitions = [...text.matchAll(definition)];
  if (definitions.length !== 1 || Number(definitions[0]![1]) !== g) throw unverifiable();
  const entry = xrefOffsets(raw).get(n);
  if (!entry || entry.generation !== g) throw unverifiable();
  const strictObject = new RegExp(
    `^0*${n}${WS}+0*${g}${WS}+obj${WS}+(\\d{1,9})${WS}+endobj${NOT_REGULAR_AFTER}`,
  );
  const body = strictObject.exec(raw.slice(entry.offset, entry.offset + 64));
  if (!body) throw unverifiable();
  return positiveInteger(body[1]!);
}

function onlyDirectInteger(
  raw: string,
  text: string,
  dict: string,
  key: "Width" | "Height",
): number {
  const all = [...dict.matchAll(new RegExp(`/${key}(?![A-Za-z0-9])`, "g"))];
  if (all.length !== 1) throw unverifiable();
  const match = new RegExp(
    `/${key}${WS}+(\\d{1,9})(?![\\d.])(?:${WS}+(\\d{1,5})${WS}+R${NOT_REGULAR_AFTER})?${DELIMITER_AFTER}`,
  ).exec(dict);
  if (!match) throw unverifiable();
  // Referință indirectă: rezolvată doar fără ambiguitate (vezi `resolveIndirectInteger`); fără
  // comentarii în dicționarul imaginii („în apropierea” referinței).
  if (match[2] !== undefined) {
    if (dict.includes("%")) throw unverifiable();
    return resolveIndirectInteger(raw, text, match[1]!, match[2]);
  }
  // Un număr direct urmat de altceva decât `G R` (de exemplu `10 0` fără R) rămâne valoarea.
  return positiveInteger(match[1]!);
}

/** Imaginile declarate, cu regulile de mai sus (fără nicio decodare). */
export function scanPdfImages(input: Uint8Array, limits: PdfScanLimits): PdfImageInfo[] {
  const raw = latin1Of(input);
  const text = structuralText(raw);
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
    const width = onlyDirectInteger(raw, text, dict, "Width");
    const height = onlyDirectInteger(raw, text, dict, "Height");
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
