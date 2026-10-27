/**
 * Aritmetică monetară FINET: singura cale prin care se calculează, se împart, se parsează și se
 * formatează sume (master prompt 5.1, 5.3, 6.4).
 *
 * Reguli:
 * - Sumele sunt `bigint` în unități minore (bani: 1 RON = 100 bani). Niciodată float: fără
 *   `parseFloat`, fără rotunjiri pe `number`, fără `Number(...)` pe sume. Singura excepție e
 *   conversia verificată din `toJson`, explicată acolo.
 * - Monedele permise: RON (implicit), EUR, USD. Operațiile cer aceeași monedă; nu există conversie
 *   valutară aici (cursul BNR vine într-o fază ulterioară).
 * - Împărțirile folosesc metoda restului cel mai mare: suma părților e exact totalul.
 */

/** Monedele permise pe cont (ISO 4217). */
export const CURRENCIES = ["RON", "EUR", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Moneda implicită a aplicației. */
export const DEFAULT_CURRENCY: Currency = "RON";

/** Numărul de zecimale (exponentul unității minore) pentru fiecare monedă. */
export const MINOR_UNIT_DIGITS: Readonly<Record<Currency, number>> = {
  RON: 2,
  EUR: 2,
  USD: 2,
};

export type Money = Readonly<{ amountMinor: bigint; currency: Currency }>;

/** Tipul unei tranzacții; semnul sumei rezultă din el (5.1). */
export type TransactionType = "income" | "expense" | "transfer";

/** Limita sigură pentru JSON (6.4): sumele circulă ca întregi JSON sub 2^53. */
export const MAX_JSON_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

// ---------------------------------------------------------------------------------------------
// Erori tipizate
// ---------------------------------------------------------------------------------------------

/** Eroare de bază pentru toate erorile din modulul monetar. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Operație între sume în monede diferite. */
export class CurrencyMismatchError extends MoneyError {
  constructor(
    readonly left: Currency,
    readonly right: Currency,
  ) {
    super(`Monede diferite: ${left} și ${right}. Nu se fac conversii implicite.`);
    this.name = "CurrencyMismatchError";
  }
}

/** Monedă care nu e în lista permisă. */
export class UnsupportedCurrencyError extends MoneyError {
  constructor(readonly currency: unknown) {
    super(`Moneda nu este permisă: ${String(currency)}.`);
    this.name = "UnsupportedCurrencyError";
  }
}

/** Sumă care nu poate fi serializată sigur în JSON (în afara intervalului ±(2^53 − 1)). */
export class MoneyOverflowError extends MoneyError {
  constructor(readonly amountMinor: bigint) {
    super(`Suma ${amountMinor} depășește limita sigură pentru JSON (2^53 − 1).`);
    this.name = "MoneyOverflowError";
  }
}

/** Motivele pentru care un text nu poate fi parsat ca sumă. */
export type InvalidAmountReason =
  | "empty"
  | "too_long"
  | "invalid_characters"
  | "invalid_sign"
  | "negative_not_allowed"
  | "ambiguous"
  | "too_many_decimals"
  | "invalid_format"
  | "out_of_range";

const PARSE_MESSAGES: Readonly<Record<InvalidAmountReason, string>> = {
  empty: "Introdu o sumă.",
  too_long: "Suma este prea lungă.",
  invalid_characters: "Suma poate conține doar cifre, virgulă, punct și spații.",
  invalid_sign: "Semnul sumei nu este valid.",
  negative_not_allowed: "Suma nu poate fi negativă.",
  ambiguous: "Suma este ambiguă. Scrie zecimalele cu virgulă, de exemplu 1234,50.",
  too_many_decimals: "Suma poate avea cel mult două zecimale.",
  invalid_format: "Formatul sumei nu este valid.",
  out_of_range: "Suma este prea mare.",
};

/** Text care nu poate fi interpretat sigur ca sumă. `reason` e stabil, pentru UI și teste. */
export class InvalidAmountError extends MoneyError {
  constructor(
    readonly reason: InvalidAmountReason,
    readonly input: string,
  ) {
    super(PARSE_MESSAGES[reason]);
    this.name = "InvalidAmountError";
  }
}

// ---------------------------------------------------------------------------------------------
// Constructori și validare
// ---------------------------------------------------------------------------------------------

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

function assertCurrency(value: unknown): Currency {
  if (!isCurrency(value)) {
    throw new UnsupportedCurrencyError(value);
  }
  return value;
}

/**
 * Construiește o sumă. `amountMinor` trebuie să fie `bigint` (orice semn; semnul negativ apare în
 * rapoarte). Limita de 2^53 se verifică la serializarea JSON, nu aici, ca rapoartele să poată
 * calcula intermediar și peste ea.
 */
export function money(amountMinor: bigint, currency: Currency): Money {
  if (typeof amountMinor !== "bigint") {
    throw new MoneyError("Suma trebuie să fie bigint în unități minore.");
  }
  return Object.freeze({ amountMinor, currency: assertCurrency(currency) });
}

/** Suma zero în moneda dată. */
export function zero(currency: Currency): Money {
  return money(0n, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

// ---------------------------------------------------------------------------------------------
// Aritmetică
// ---------------------------------------------------------------------------------------------

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function sub(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amountMinor, a.currency);
}

/** Compară două sume în aceeași monedă: -1, 0 sau 1. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0n;
}

export function isNegative(a: Money): boolean {
  return a.amountMinor < 0n;
}

/**
 * Suma unei liste. Moneda e obligatorie, ca lista goală să aibă un rezultat definit (zero în acea
 * monedă); orice element în altă monedă aruncă `CurrencyMismatchError`.
 */
export function sum(list: readonly Money[], currency: Currency): Money {
  let total = zero(currency);
  for (const item of list) {
    total = add(total, item);
  }
  return total;
}

/**
 * Suma cu semn pentru rapoarte. În baza de date `amount_minor` e mereu pozitiv, iar semnul vine din
 * tip (5.1): venit = +, cheltuială = −, transfer = 0 (neutru la totaluri, mută bani între conturi).
 */
export function signedAmount(type: TransactionType, amountMinor: bigint): bigint {
  if (typeof amountMinor !== "bigint") {
    throw new MoneyError("Suma trebuie să fie bigint în unități minore.");
  }
  if (amountMinor < 0n) {
    throw new MoneyError("amount_minor trebuie să fie pozitiv; semnul rezultă din tip.");
  }
  switch (type) {
    case "income":
      return amountMinor;
    case "expense":
      return -amountMinor;
    case "transfer":
      return 0n;
    default:
      throw new MoneyError(`Tip de tranzacție necunoscut: ${String(type)}.`);
  }
}

// ---------------------------------------------------------------------------------------------
// Împărțire (metoda restului cel mai mare)
// ---------------------------------------------------------------------------------------------

function toWeight(weight: bigint | number, index: number): bigint {
  if (typeof weight === "bigint") {
    if (weight < 0n) throw new MoneyError(`Ponderea ${index} este negativă.`);
    return weight;
  }
  // Ponderile nu sunt sume; acceptăm și `number`, dar doar întregi sigure, nenegative.
  if (!Number.isSafeInteger(weight) || weight < 0) {
    throw new MoneyError(`Ponderea ${index} trebuie să fie un întreg nenegativ.`);
  }
  return BigInt(weight);
}

/**
 * Împarte `total` proporțional cu `weights`, prin metoda restului cel mai mare: fiecare parte
 * primește partea întreagă a lui total × pondere / Σponderi, iar unitățile minore rămase se dau,
 * câte una, părților cu restul cel mai mare. La rest egal câștigă indexul mai mic, deci rezultatul
 * e determinist. Suma părților este exact `total`.
 */
export function allocate(total: Money, weights: readonly (bigint | number)[]): Money[] {
  if (total.amountMinor < 0n) {
    throw new MoneyError("Totalul de împărțit nu poate fi negativ.");
  }
  if (weights.length === 0) {
    throw new MoneyError("Lista de ponderi este goală.");
  }
  const w = weights.map(toWeight);
  const weightSum = w.reduce((acc, x) => acc + x, 0n);
  if (weightSum === 0n) {
    throw new MoneyError("Suma ponderilor este zero.");
  }

  const parts = w.map((x) => (total.amountMinor * x) / weightSum);
  const remainders = w.map((x) => (total.amountMinor * x) % weightSum);
  let leftover = total.amountMinor - parts.reduce((acc, x) => acc + x, 0n);

  // leftover < numărul de părți, deci o singură trecere prin ordinea sortată e suficientă.
  const order = w.map((_, i) => i);
  order.sort((i, j) => {
    const ri = remainders[i]!;
    const rj = remainders[j]!;
    if (ri !== rj) return ri > rj ? -1 : 1;
    return i - j;
  });
  for (const i of order) {
    if (leftover === 0n) break;
    parts[i] = parts[i]! + 1n;
    leftover -= 1n;
  }

  return parts.map((p) => money(p, total.currency));
}

/** Împarte `total` în `n` părți cât mai egale; primele părți primesc unitățile rămase. */
export function splitEqual(total: Money, n: number): Money[] {
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new MoneyError("Numărul de părți trebuie să fie un întreg pozitiv.");
  }
  return allocate(total, new Array<bigint>(n).fill(1n));
}

// ---------------------------------------------------------------------------------------------
// Parsare input românesc
// ---------------------------------------------------------------------------------------------

export type ParseAmountOptions = {
  /** Acceptă un `-` în față (implicit nu: sumele introduse de utilizator sunt pozitive). */
  allowNegative?: boolean;
};

const MAX_INPUT_LENGTH = 40;
// Spații acceptate ca separator de mii: spațiu, NBSP (U+00A0), spațiu îngust NNBSP (U+202F).
const SPACE_LIKE = /[   ]/g;

/**
 * Validează partea întreagă. Fără separator: doar cifre. Cu separator de mii: un singur tip de
 * separator (`.`, `,` sau spațiu), primul grup 1–3 cifre, restul exact 3 cifre.
 * Întoarce cifrele fără separatori sau `null` dacă forma nu e validă.
 */
function parseIntegerPart(part: string, forbidden: string | null): string | null {
  if (/^\d+$/.test(part)) return part;
  const separators = new Set(part.replace(/\d/g, ""));
  if (separators.size !== 1) return null;
  const sep = [...separators][0]!;
  if (sep === forbidden) return null;
  const groups = part.split(sep);
  const [first, ...rest] = groups;
  if (!/^\d{1,3}$/.test(first!)) return null;
  if (!rest.every((g) => /^\d{3}$/.test(g))) return null;
  return groups.join("");
}

/**
 * Parsează o sumă scrisă de utilizator, fără a trece prin float.
 *
 * Forme acceptate: `1234,56`, `1.234,56`, `1234.56`, `1 234,56` (spațiu sau NBSP), `1.234.567`,
 * `1234`, `0,5`; cu 0–2 zecimale.
 *
 * Regula separatorului zecimal: separatorul zecimal este ULTIMUL `,` sau `.` din text, dar numai
 * dacă după el urmează 1–2 cifre. Restul textului e partea întreagă, în care separatorul de mii
 * (alt caracter decât cel zecimal: `.`, `,` sau spațiu) desparte grupuri de exact 3 cifre.
 * Un singur `.` sau `,` urmat de exact 3 cifre și fără alt separator (`1.234`, `1,234`) e AMBIGUU
 * (poate fi 1234 sau 1,234) și se respinge. Repetarea aceluiași separator (`1.234.567`) nu e
 * ambiguă: e grupare de mii. Forma în oglindă `1,234.56` e acceptată (decizia mea: e neambiguă).
 * Se resping: mai mult de 2 zecimale, separatori amestecați în partea întreagă, semne multiple,
 * litere, lipsa cifrei înainte de virgulă (`,50`), textul gol și sumele peste 2^53 − 1.
 */
export function parseAmount(
  input: string,
  currency: Currency,
  options: ParseAmountOptions = {},
): Money {
  assertCurrency(currency);
  // Adnotarea explicită a tipului permite îngustarea tipurilor după apelurile `fail(...)`.
  const fail: (reason: InvalidAmountReason) => never = (reason) => {
    throw new InvalidAmountError(reason, input);
  };

  if (typeof input !== "string") fail("invalid_format");
  let s = input.replace(SPACE_LIKE, " ").trim();
  if (s === "") fail("empty");
  if (s.length > MAX_INPUT_LENGTH) fail("too_long");

  let negative = false;
  if (s[0] === "-" || s[0] === "+") {
    negative = s[0] === "-";
    s = s.slice(1);
  }
  // Al doilea semn (inclusiv semnul minus Unicode U+2212) oriunde în text.
  if (/[-+−]/.test(s)) fail("invalid_sign");
  if (s === "") fail("invalid_format");
  if (!/^[\d., ]+$/.test(s)) fail("invalid_characters");
  if (!/^\d/.test(s)) fail("invalid_format");
  if (negative && !options.allowNegative) fail("negative_not_allowed");

  const digits = MINOR_UNIT_DIGITS[currency];
  const lastSep = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  const tail = lastSep >= 0 ? s.slice(lastSep + 1) : "";

  let integerDigits: string;
  let fraction = "";
  if (lastSep >= 0 && /^\d{1,2}$/.test(tail) && tail.length <= digits) {
    // Separator zecimal valid.
    const decimalSep = s[lastSep]!;
    const parsed = parseIntegerPart(s.slice(0, lastSep), decimalSep);
    if (parsed === null) return fail("invalid_format");
    integerDigits = parsed;
    fraction = tail;
  } else {
    const parsed = parseIntegerPart(s, null);
    if (parsed !== null) {
      const single = s.replace(/[\d ]/g, "");
      // Un singur `.`/`,` urmat de 3 cifre: 1.234 poate fi 1234 sau 1,234.
      if (single.length === 1) fail("ambiguous");
      integerDigits = parsed;
    } else {
      // Nu e grupare validă. Dacă partea dinaintea ultimului separator e o parte întreagă validă și
      // după separator urmează 3 sau mai multe cifre, sunt prea multe zecimale (`1234,567`,
      // `1,2345`, `1.234,567`); altfel forma e pur și simplu greșită (`1.23.456`).
      if (
        lastSep >= 0 &&
        /^\d{3,}$/.test(tail) &&
        parseIntegerPart(s.slice(0, lastSep), s[lastSep]!) !== null
      ) {
        fail("too_many_decimals");
      }
      return fail("invalid_format");
    }
  }

  const scale = 10n ** BigInt(digits);
  const minor = BigInt(integerDigits) * scale + BigInt(fraction.padEnd(digits, "0") || "0");
  if (minor > MAX_JSON_SAFE_MINOR) fail("out_of_range");
  return money(negative ? -minor : minor, currency);
}

// ---------------------------------------------------------------------------------------------
// Formatare
// ---------------------------------------------------------------------------------------------

/**
 * Reprezentare zecimală exactă, cu punct și fără grupare: `-1234.56`. Utilă pentru `Intl` și
 * pentru exporturi (CSV). Compusă din bigint, fără float.
 */
export function toDecimalString(m: Money): string {
  const digits = MINOR_UNIT_DIGITS[m.currency];
  const negative = m.amountMinor < 0n;
  const abs = negative ? -m.amountMinor : m.amountMinor;
  const raw = abs.toString().padStart(digits + 1, "0");
  const integer = raw.slice(0, raw.length - digits);
  const fraction = raw.slice(raw.length - digits);
  return `${negative ? "-" : ""}${integer}${digits > 0 ? `.${fraction}` : ""}`;
}

const formatterCache = new Map<string, Intl.NumberFormat>();

function formatterFor(locale: string, currency: Currency): Intl.NumberFormat {
  const key = `${locale}|${currency}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    const digits = MINOR_UNIT_DIGITS[currency];
    formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      // `narrowSymbol` dă „lei”, „€” și „$” în ro-RO; afișarea implicită ar da „RON” (vezi 5.3).
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      // Fără „-0,00”: semnul apare doar la valori strict negative.
      signDisplay: "negative",
    });
    formatterCache.set(key, formatter);
  }
  return formatter;
}

/**
 * Formatează pentru afișare: `1.234,56 lei`, `1.234,56 €`, `-1.234,56 lei`. Între număr și simbol
 * runtime-ul pune un NBSP (U+00A0). `Intl.NumberFormat` primește șirul zecimal exact (suportat de
 * `format` pentru string-uri numerice), deci nu există pierdere de precizie nici peste 2^53.
 */
export function formatMoney(m: Money, locale = "ro-RO"): string {
  const decimal = toDecimalString(m) as Intl.StringNumericLiteral;
  return formatterFor(locale, m.currency).format(decimal);
}

// ---------------------------------------------------------------------------------------------
// Serializare API (6.4)
// ---------------------------------------------------------------------------------------------

export type MoneyJson = { amountMinor: number; currency: Currency };

/**
 * Serializează pentru API: `amountMinor` ca întreg JSON (număr), conform 6.4. Conversia
 * `Number(...)` de mai jos e singura conversie bigint → number din modul și e exactă, pentru că
 * verificăm întâi că valoarea e în ±(2^53 − 1); peste limită aruncă `MoneyOverflowError`.
 */
export function toJson(m: Money): MoneyJson {
  if (m.amountMinor > MAX_JSON_SAFE_MINOR || m.amountMinor < -MAX_JSON_SAFE_MINOR) {
    throw new MoneyOverflowError(m.amountMinor);
  }
  return { amountMinor: Number(m.amountMinor), currency: m.currency };
}

/**
 * Inversul lui `toJson`. Acceptă doar `{ amountMinor: <întreg sigur>, currency: <monedă permisă> }`;
 * respinge zecimale (`12.5`), `NaN`, infinit, string-uri și valori peste 2^53 − 1.
 */
export function fromJson(value: unknown): Money {
  if (typeof value !== "object" || value === null) {
    throw new MoneyError("Suma JSON trebuie să fie un obiect { amountMinor, currency }.");
  }
  const { amountMinor, currency } = value as { amountMinor?: unknown; currency?: unknown };
  if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor)) {
    throw new MoneyError("amountMinor trebuie să fie un număr întreg sigur (sub 2^53).");
  }
  return money(BigInt(amountMinor), assertCurrency(currency));
}
