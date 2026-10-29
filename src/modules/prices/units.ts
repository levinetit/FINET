/**
 * Unitățile de măsură și prețul pe unitate standard (Faza 10, F10-B; ADR 0023). Funcții PURE, toată
 * aritmetica pe `bigint` (niciodată float).
 *
 * `receipt_lines` NU are coloană de unitate: ambalajul se citește din numele normalizat
 * (`normalizeProductName`: `500g`, `1l`, `0.5l`, `33cl`, `6buc`, `6x0.5l`). Trei situații:
 * - **sized**: o singură mărime recunoscută → preț pe unitate standard (kg, l, buc);
 * - **unsized**: nicio mărime → preț pe „unitate de vânzare” (cantitatea de pe bon, oricare ar fi);
 * - **ambiguous**: două mărimi diferite (`apa 2l 6buc`), mărime ilizibilă sau un produs cântărit al
 *   cărui nume repetă greutatea vândută (`banane 1.234kg` cu cantitatea 1,234) → EXCLUS din
 *   comparații (nu ghicim).
 * Conversii doar între unități compatibile: g ↔ kg (masă), ml ↔ cl ↔ l (volum), buc (numărătoare);
 * masa, volumul și numărătoarea nu se amestecă niciodată (cheia produsului poartă unitatea).
 * Monedele nu se convertesc: moneda face parte din orice grupare, în afara acestui modul.
 */

export type StdUnit = "kg" | "l" | "buc";
export type UnitDimension = StdUnit | "unit";

/** O mărime recunoscută în nume: cantitate de unități standard, în miimi (milli-kg, milli-l, milli-buc). */
export type SizeInfo =
  | Readonly<{
      kind: "sized";
      /** Unitatea standard în care se compară prețul. */
      unit: StdUnit;
      /** Conținutul unui ambalaj, în miimi de unitate standard (`500g` → 500 milli-kg). */
      packMilli: bigint;
      /** Numele fără mărime (`cafea macinata`): cheia de comparație între ambalaje. */
      baseName: string;
    }>
  | Readonly<{ kind: "unsized"; baseName: string }>
  | Readonly<{ kind: "ambiguous" }>;

const SIZE_TOKEN =
  /(?<![a-z0-9.])(?:(\d{1,3})x)?(\d{1,6}(?:\.\d{1,3})?)(kg|g|ml|cl|l|buc)(?![a-z0-9])/g;

/** `0.5` → 500n; `1.234` → 1234n; `12` → 12000n (miimi). */
export function toMilli(decimal: string): bigint {
  const [int = "0", frac = ""] = decimal.split(".");
  return BigInt(int) * 1000n + BigInt(frac.padEnd(3, "0").slice(0, 3));
}

/** Cantitatea de pe bon (`numeric(12,3)` ca text) în miimi; lipsa înseamnă 1. */
export function quantityMilli(quantity: string | null): bigint {
  return quantity === null ? 1000n : toMilli(quantity);
}

/** Rotunjire „jumătate în sus” a unui raport de numere ≥ 0 (numitor > 0). */
export function divRound(n: bigint, d: bigint): bigint {
  return (n * 2n + d) / (2n * d);
}

/** `n / d` rotunjit jumătate dinspre zero (d > 0). */
export function divRoundHalfAway(n: bigint, d: bigint): bigint {
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = (a * 2n + d) / (2n * d);
  return neg ? -q : q;
}

function normalizeSpaces(name: string): string {
  // `6 x 0.5l` → `6x0.5l` (aceeași mărime scrisă cu spații).
  return name.replace(/(\d)\s+x\s+(\d)/g, "$1x$2");
}

/**
 * Mărimea unui ambalaj din numele normalizat. `quantity` (miimi) servește doar la detectarea
 * produselor cântărite (vezi mai sus).
 */
export function parseSize(normalizedName: string, quantity: bigint): SizeInfo {
  const name = normalizeSpaces(normalizedName);
  const matches = [...name.matchAll(SIZE_TOKEN)];
  if (matches.length === 0) return { kind: "unsized", baseName: name };
  if (matches.length > 1) return { kind: "ambiguous" };
  const m = matches[0]!;
  const multiplier = m[1] === undefined ? 1n : BigInt(m[1]);
  const amountMilli = toMilli(m[2]!);
  const unit = m[3]!;
  let std: StdUnit;
  let pack: bigint;
  switch (unit) {
    case "kg":
      std = "kg";
      pack = amountMilli;
      break;
    case "g":
      std = "kg";
      if (amountMilli % 1000n !== 0n) return { kind: "ambiguous" };
      pack = amountMilli / 1000n;
      break;
    case "l":
      std = "l";
      pack = amountMilli;
      break;
    case "cl":
      std = "l";
      if (amountMilli % 100n !== 0n) return { kind: "ambiguous" };
      pack = amountMilli / 100n;
      break;
    case "ml":
      std = "l";
      if (amountMilli % 1000n !== 0n) return { kind: "ambiguous" };
      pack = amountMilli / 1000n;
      break;
    default:
      // buc
      std = "buc";
      pack = amountMilli;
  }
  pack *= multiplier;
  if (pack <= 0n) return { kind: "ambiguous" };
  // Produs cântărit: numele repetă greutatea vândută (cantitate zecimală egală cu mărimea).
  if (
    (std === "kg" || std === "l") &&
    unit === std &&
    quantity === amountMilli &&
    quantity % 1000n !== 0n
  ) {
    return { kind: "ambiguous" };
  }
  const at = m.index ?? 0;
  const baseName = `${name.slice(0, at)} ${name.slice(at + m[0].length)}`
    .replace(/ {2,}/g, " ")
    .trim();
  if (baseName === "") return { kind: "ambiguous" };
  return { kind: "sized", unit: std, packMilli: pack, baseName };
}

/** Dimensiunea cheii de produs: unitatea standard sau `unit` (fără mărime). */
export function dimensionOf(size: SizeInfo): UnitDimension | null {
  if (size.kind === "sized") return size.unit;
  if (size.kind === "unsized") return "unit";
  return null;
}

/** Cheia de produs (comparabilă între ambalaje): `<unitate>|<nume fără mărime>`; `null` = exclus. */
export function productKeyOf(size: SizeInfo): string | null {
  if (size.kind === "ambiguous") return null;
  return `${dimensionOf(size)}|${size.baseName}`;
}

/** Cantitatea vândută a unei linii, în miimi de unitate de comparație (`µ`): milli-sale × milli-std. */
export function comparisonQuantity(size: SizeInfo, quantity: bigint): bigint {
  // unsized: cantitatea de pe bon (miimi de unitate de vânzare) × 1000 (factor neutru), ca
  // numitorul să aibă aceeași scară ca la `sized`.
  return size.kind === "sized" ? quantity * size.packMilli : quantity * 1000n;
}

/**
 * Prețul pe unitate de comparație (bani pe kg / l / buc / unitate de vânzare) din SUME agregate:
 * `Σ total / Σ cantitate`, rotunjit la ban, jumătate în sus. `denominator` vine din
 * `comparisonQuantity` (sumat). `null` dacă numitorul nu e pozitiv.
 */
export function unitPriceMinor(totalMinor: bigint, denominator: bigint): bigint | null {
  if (denominator <= 0n || totalMinor < 0n) return null;
  return divRound(totalMinor * 1_000_000n, denominator);
}
