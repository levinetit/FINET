/**
 * Curățarea textului citit de model și normalizarea numelor de produse (master prompt 3.6;
 * ADR 0014). Funcții pure.
 *
 * Textul de pe bon (și deci ieșirea modelului) e o dată NEÎNCREZĂTOARE: caracterele de control,
 * cele de direcție (bidi) și cele de lățime zero se elimină, spațiile se comprimă, iar lungimea se
 * plafonează. Textul nu e niciodată interpretat (nu e HTML, comandă sau prompt pentru alt pas).
 */

// C0/C1 (fără spațiile obișnuite, convertite mai jos), bidi (U+202A–202E, U+2066–2069),
// lățime zero și BOM (U+200B–200F, U+2060, U+FEFF), separatoarele de linie/paragraf.
const CONTROL = new RegExp(
  "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2069\\ufeff]",
  "g",
);

/** Text liber de la model → text sigur de afișat/stocat (sau `null` dacă rămâne gol). */
export function cleanText(raw: string | null | undefined, maxLength: number): string | null {
  if (typeof raw !== "string") return null;
  const s = raw
    .normalize("NFC")
    .replace(CONTROL, "")
    .replace(/[\t\r\n\u00a0\u202f]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  if (s === "") return null;
  // Tăiere pe puncte de cod (fără jumătăți de pereche surogat).
  const chars = Array.from(s);
  return chars.length > maxLength ? chars.slice(0, maxLength).join("").trimEnd() : s;
}

const DIACRITICS: Readonly<Record<string, string>> = {
  ă: "a",
  â: "a",
  î: "i",
  ș: "s",
  ş: "s",
  ț: "t",
  ţ: "t",
};

/**
 * Numele normalizat al unui produs (cheia din `product_aliases`): litere mici, fără diacritice,
 * fără punctuație decorativă, cu unitățile de măsură și ambalajele scrise uniform:
 * `LAPTE ZUZU 1,5% 1 L` → `lapte zuzu 1.5% 1l`; `CAFEA 500 GR` → `cafea 500g`;
 * `APA PLATA 2 LT PET` → `apa plata 2l pet`; `BANANE 1,234 KG` → `banane 1.234kg`.
 * Determinist; marca nu se elimină (nu există o listă sigură de mărci).
 */
export function normalizeProductName(raw: string): string | null {
  const cleaned = cleanText(raw, 300);
  if (cleaned === null) return null;
  let s = cleaned.toLowerCase();
  s = s.replace(/[ăâîșşțţ]/g, (c) => DIACRITICS[c] ?? c);
  s = s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  // Zecimale cu virgulă → punct, între cifre (1,5 → 1.5).
  s = s.replace(/(\d),(\d)/g, "$1.$2");
  // Punctuație decorativă → spațiu (păstrăm . % pentru numere și procente).
  s = s.replace(/[^a-z0-9.% ]+/g, " ");
  // Unități: număr + spațiu + unitate → lipite, unități scrise uniform.
  const UNITS: ReadonlyArray<readonly [RegExp, string]> = [
    [/(\d)\s*(?:kg|kgr)\b/g, "$1kg"],
    [/(\d)\s*(?:gr|g|grame)\b/g, "$1g"],
    [/(\d)\s*(?:ml)\b/g, "$1ml"],
    [/(\d)\s*(?:cl)\b/g, "$1cl"],
    [/(\d)\s*(?:l|lt|ltr|litri|litru)\b/g, "$1l"],
    [/(\d)\s*(?:buc|bucati|bc)\b/g, "$1buc"],
    [/(\d)\s*%/g, "$1%"],
  ];
  for (const [re, to] of UNITS) s = s.replace(re, to);
  // Punctele rămase în afara numerelor dispar.
  s = s.replace(/(?<!\d)\.|\.(?!\d)/g, " ");
  s = s.replace(/ {2,}/g, " ").trim();
  if (s === "") return null;
  return s.length > 300 ? s.slice(0, 300).trimEnd() : s;
}
