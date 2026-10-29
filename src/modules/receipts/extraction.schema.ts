import { z } from "zod";

import { MAX_AMOUNT_MINOR } from "@/modules/ledger/input";
import { type Currency, InvalidAmountError, parseAmount } from "@/lib/money";

import { normalizeTaxId } from "./cui";
import { cleanText, normalizeProductName } from "./normalize";
import { parseRateBp } from "./vat";

/**
 * Schema JSON-ului întors de model pentru un bon (master prompt 5.5; ADR 0014) și conversia lui
 * în tipurile FINET. Ieșirea modelului e o dată NEÎNCREZĂTOARE:
 * - Zod STRICT: câmpurile necunoscute (inclusiv în linii) → respins; liste plafonate (≤ 500 de
 *   linii); șiruri plafonate;
 * - sumele sunt ȘIRURI cu punct și cel mult 2 zecimale (`"12.50"`): un număr JSON e respins (ar fi
 *   trecut prin float); conversia prin `parseAmount` (bigint), plafon 10^13 (`MAX_AMOUNT_MINOR`);
 * - cantitatea e șir (`"0.754"`, ≤ 3 zecimale, pentru `numeric(12,3)`), niciodată `Number`;
 * - textul liber se curăță (control, bidi, lățime zero) și se plafonează (`cleanText`).
 * Modelul nu calculează nimic: totalurile și verificările le face codul (`checks.ts`).
 */

export const MAX_RECEIPT_LINES = 500;
const AMOUNT = /^\d{1,11}(?:\.\d{1,2})?$/;
const QUANTITY = /^\d{1,9}(?:\.\d{1,3})?$/;
const RATE = /^\d{1,2}(?:\.\d{1,2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const amount = z.string().max(20).regex(AMOUNT);
const text = (max: number) => z.string().max(max * 2);

export const MODEL_LINE_TYPES = ["item", "discount", "deposit", "bag", "other"] as const;
export const MODEL_PAYMENT_METHODS = ["cash", "card", "voucher", "mixed", "other"] as const;

export const modelLineSchema = z.strictObject({
  name: text(300).min(1),
  quantity: z.string().max(16).regex(QUANTITY).nullable(),
  unitPrice: amount.nullable(),
  lineTotal: amount,
  vatRate: z.string().max(6).regex(RATE).nullable(),
  type: z.enum(MODEL_LINE_TYPES),
});

export const modelReceiptSchema = z.strictObject({
  merchantName: text(200).nullable(),
  merchantTaxId: z.string().max(24).nullable(),
  storeAddress: text(300).nullable(),
  receiptNumber: z.string().max(64).nullable(),
  date: z.string().max(10).regex(DATE).nullable(),
  paymentMethod: z.enum(MODEL_PAYMENT_METHODS).nullable(),
  currency: z.enum(["RON", "EUR", "USD"]).nullable(),
  total: amount.nullable(),
  vatTotal: amount.nullable(),
  lines: z.array(modelLineSchema).max(MAX_RECEIPT_LINES),
});
export type ModelReceipt = z.infer<typeof modelReceiptSchema>;

type ReceiptKey = keyof typeof modelReceiptSchema.shape;
type LineKey = keyof typeof modelLineSchema.shape;

/**
 * Descrierea fiecărui câmp, pentru prompt (în modul `json_object` modelul nu primește schema
 * JSON). Tipul `Record<cheie, …>` obligă descrierea să aibă EXACT cheile schemei Zod (un câmp nou
 * fără descriere nu compilează), iar un test verifică promptul generat față de schemă.
 */
const RECEIPT_FIELD_DOCS: Readonly<Record<ReceiptKey, string>> = {
  merchantName: "string sau null — numele comerciantului, ca pe bon",
  merchantTaxId: 'string sau null — CUI/CIF, cu sau fără "RO", exact cum apare',
  storeAddress: "string sau null — adresa magazinului",
  receiptNumber: "string sau null — numărul bonului",
  date: 'string sau null — data bonului, format "YYYY-MM-DD"',
  paymentMethod: `unul dintre ${MODEL_PAYMENT_METHODS.map((m) => `"${m}"`).join(", ")} sau null`,
  currency: '"RON", "EUR", "USD" sau null',
  total: 'string sau null — TOTALUL de plată, ex. "45.90" (punct zecimal, max. 2 zecimale)',
  vatTotal: 'string sau null — totalul TVA de pe bon, ex. "4.55"',
  lines: `listă (max. ${MAX_RECEIPT_LINES}) de obiecte-linie, în ordinea de pe bon`,
};
const LINE_FIELD_DOCS: Readonly<Record<LineKey, string>> = {
  name: "string — denumirea produsului, ca pe bon",
  quantity: 'string sau null — cantitatea, ex. "1" sau "0.754" (max. 3 zecimale)',
  unitPrice: 'string sau null — prețul unitar, ex. "7.49"',
  lineTotal: 'string — totalul liniei, POZITIV, ex. "14.98" (și pentru reduceri)',
  vatRate: 'string sau null — cota TVA a liniei în procente, ex. "21" sau "11"',
  type: `unul dintre ${MODEL_LINE_TYPES.map((t) => `"${t}"`).join(", ")}`,
};

/** Un exemplu complet, SINTETIC (date inventate), valid după `modelReceiptSchema`. */
export const RECEIPT_PROMPT_EXAMPLE: ModelReceipt = {
  merchantName: "MAGAZIN EXEMPLU SRL",
  merchantTaxId: "RO22891860",
  storeAddress: "Str. Exemplu 1, Oraș",
  receiptNumber: "0042",
  date: "2026-01-15",
  paymentMethod: "card",
  currency: "RON",
  total: "15.48",
  vatTotal: "1.48",
  lines: [
    {
      name: "LAPTE 1L",
      quantity: "2",
      unitPrice: "7.49",
      lineTotal: "14.98",
      vatRate: "11",
      type: "item",
    },
    {
      name: "GARANTIE SGR",
      quantity: "1",
      unitPrice: "0.50",
      lineTotal: "0.50",
      vatRate: "0",
      type: "deposit",
    },
  ],
};

/**
 * Schema ca TEXT, pentru promptul sistem (în orice mod de răspuns): cheile exacte, tipurile,
 * valorile permise, `null` pentru necitibil, un exemplu și interdicția altor chei. Generată din
 * aceeași schemă Zod, deci nu poate diverge (test de sincronizare în `receipts.test.ts`).
 */
export function receiptSchemaPromptText(): string {
  const receiptKeys = Object.keys(modelReceiptSchema.shape) as ReceiptKey[];
  const lineKeys = Object.keys(modelLineSchema.shape) as LineKey[];
  return [
    `Răspunsul e UN obiect JSON cu EXACT aceste ${receiptKeys.length} chei (toate prezente, nicio altă cheie):`,
    ...receiptKeys.map((k) => `- "${k}": ${RECEIPT_FIELD_DOCS[k]}`),
    `Fiecare element din "lines" are EXACT aceste ${lineKeys.length} chei (toate prezente, nicio altă cheie):`,
    ...lineKeys.map((k) => `- "${k}": ${LINE_FIELD_DOCS[k]}`),
    "Sumele, cantitățile și cotele sunt ȘIRURI (în ghilimele), nu numere. Ce nu se poate citi e null.",
    'Nu folosi alte nume de chei (de exemplu NU "merchant", "items", "totals", "payment").',
    "Exemplu (date inventate):",
    JSON.stringify(RECEIPT_PROMPT_EXAMPLE),
  ].join("\n");
}

/** Schema JSON trimisă furnizorului (`response_format: json_schema`, strict), aceeași formă. */
export const RECEIPT_JSON_SCHEMA: Readonly<Record<string, unknown>> = (() => {
  const nullableString = (pattern?: string, maxLength?: number) => ({
    type: ["string", "null"],
    ...(pattern ? { pattern } : {}),
    ...(maxLength ? { maxLength } : {}),
  });
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "merchantName",
      "merchantTaxId",
      "storeAddress",
      "receiptNumber",
      "date",
      "paymentMethod",
      "currency",
      "total",
      "vatTotal",
      "lines",
    ],
    properties: {
      merchantName: nullableString(undefined, 200),
      merchantTaxId: nullableString(undefined, 24),
      storeAddress: nullableString(undefined, 300),
      receiptNumber: nullableString(undefined, 64),
      date: nullableString("^\\d{4}-\\d{2}-\\d{2}$"),
      paymentMethod: { type: ["string", "null"], enum: [...MODEL_PAYMENT_METHODS, null] },
      currency: { type: ["string", "null"], enum: ["RON", "EUR", "USD", null] },
      total: nullableString(AMOUNT.source),
      vatTotal: nullableString(AMOUNT.source),
      lines: {
        type: "array",
        maxItems: MAX_RECEIPT_LINES,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "quantity", "unitPrice", "lineTotal", "vatRate", "type"],
          properties: {
            name: { type: "string", maxLength: 300 },
            quantity: nullableString(QUANTITY.source),
            unitPrice: nullableString(AMOUNT.source),
            lineTotal: { type: "string", pattern: AMOUNT.source },
            vatRate: nullableString(RATE.source),
            type: { type: "string", enum: [...MODEL_LINE_TYPES] },
          },
        },
      },
    },
  };
})();

export type ReceiptLineKind = "product" | "discount" | "deposit_sgr" | "bag" | "other";

export type ExtractedLine = Readonly<{
  rawName: string;
  normalizedName: string | null;
  /** Cantitatea ca text zecimal canonic (`"0.754"`), pentru `numeric(12,3)`; `null` dacă lipsește. */
  quantity: string | null;
  unitPriceMinor: bigint | null;
  lineTotalMinor: bigint;
  vatRateBp: number | null;
  kind: ReceiptLineKind;
}>;

export type ExtractedReceipt = Readonly<{
  merchantName: string | null;
  /** Forma canonică (`RO` + cifre) sau `null` dacă lipsește ori nu are forma de CUI. */
  merchantTaxId: string | null;
  /** `true` dacă modelul a dat un CUI care nu are forma corectă (verificările îl semnalează). */
  merchantTaxIdMalformed: boolean;
  storeAddress: string | null;
  receiptNumber: string | null;
  occurredOn: string | null;
  paymentMethod: (typeof MODEL_PAYMENT_METHODS)[number] | null;
  currency: Currency;
  totalMinor: bigint | null;
  vatTotalMinor: bigint | null;
  lines: readonly ExtractedLine[];
}>;

/** Conversia a eșuat: sumă peste plafon sau dată imposibilă (cod stabil, fără conținut). */
export class ExtractionInvalidError extends Error {
  constructor(readonly reason: "amount_out_of_range" | "date_invalid" | "schema") {
    super("Răspunsul modelului nu e un bon valid.");
    this.name = "ExtractionInvalidError";
  }
}

const KIND_OF: Readonly<Record<(typeof MODEL_LINE_TYPES)[number], ReceiptLineKind>> = {
  item: "product",
  discount: "discount",
  deposit: "deposit_sgr",
  bag: "bag",
  other: "other",
};

function toMinor(value: string, currency: Currency): bigint {
  let minor: bigint;
  try {
    minor = parseAmount(value, currency).amountMinor;
  } catch (error) {
    if (error instanceof InvalidAmountError)
      throw new ExtractionInvalidError("amount_out_of_range");
    throw error;
  }
  if (minor < 0n || minor > BigInt(MAX_AMOUNT_MINOR)) {
    throw new ExtractionInvalidError("amount_out_of_range");
  }
  return minor;
}

/** `"1"` → `"1.000"`, `"0.75"` → `"0.750"` (fără float). */
function canonicalQuantity(value: string): string {
  const [int, frac = ""] = value.split(".");
  return `${BigInt(int!).toString()}.${frac.padEnd(3, "0")}`;
}

function isRealDate(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1) return false;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= days;
}

/** Validare Zod strictă a valorii JSON (deja parsate cu plafoane) → `ModelReceipt`. */
export function parseModelReceipt(value: unknown): ModelReceipt {
  const parsed = modelReceiptSchema.safeParse(value);
  if (!parsed.success) throw new ExtractionInvalidError("schema");
  return parsed.data;
}

/** `ModelReceipt` → tipurile FINET (sume bigint, texte curățate, tipuri de linie FINET). */
export function toExtractedReceipt(m: ModelReceipt): ExtractedReceipt {
  const currency: Currency = m.currency ?? "RON";
  if (m.date !== null && !isRealDate(m.date)) throw new ExtractionInvalidError("date_invalid");
  const lines: ExtractedLine[] = [];
  for (const l of m.lines) {
    const rawName = cleanText(l.name, 300);
    if (rawName === null) continue;
    lines.push({
      rawName,
      normalizedName: normalizeProductName(rawName),
      quantity: l.quantity === null ? null : canonicalQuantity(l.quantity),
      unitPriceMinor: l.unitPrice === null ? null : toMinor(l.unitPrice, currency),
      lineTotalMinor: toMinor(l.lineTotal, currency),
      vatRateBp: l.vatRate === null ? null : parseRateBp(l.vatRate),
      kind: KIND_OF[l.type],
    });
  }
  const taxRaw = m.merchantTaxId === null ? null : cleanText(m.merchantTaxId, 24);
  const taxId = normalizeTaxId(taxRaw);
  const receiptNumber = cleanText(m.receiptNumber, 64);
  return {
    merchantName: cleanText(m.merchantName, 200),
    merchantTaxId: taxId,
    merchantTaxIdMalformed: taxRaw !== null && taxId === null,
    storeAddress: cleanText(m.storeAddress, 300),
    receiptNumber,
    occurredOn: m.date,
    paymentMethod: m.paymentMethod,
    currency,
    totalMinor: m.total === null ? null : toMinor(m.total, currency),
    vatTotalMinor: m.vatTotal === null ? null : toMinor(m.vatTotal, currency),
    lines,
  };
}
