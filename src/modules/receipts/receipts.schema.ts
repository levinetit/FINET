import { z } from "zod";

import {
  AI_PROVIDERS_USED,
  FALLBACK_REASONS,
  PAYMENT_METHODS,
  RECEIPT_LINE_KINDS,
  RECEIPT_MAX_LINES,
  RECEIPT_STATUSES,
} from "@/db/schema";
import { ValidationError } from "@/lib/errors";
import { type Currency, MAX_JSON_SAFE_MINOR, MoneyOverflowError } from "@/lib/money";
import { dateSchema, idSchema, optionalText } from "@/modules/ledger/input";

import type { IssueCode } from "./checks";

/**
 * Formele publice ale bonurilor (Faza 6, F6-C; ADR 0015): interogarea listei, corectarea
 * (`PATCH`), confirmarea și vederile JSON. Zod STRICT peste tot: o cheie necunoscută (de exemplu
 * `householdId`, `status`, `transactionId`) e respinsă. Sumele vin DOAR ca întregi în unități
 * minore (`…Minor`, 6.4); UI-ul parsează textul scris de utilizator cu `parseAmount`. Cantitatea
 * și cota TVA sunt TEXT zecimal (fără float), ca în bază (`numeric`).
 */

export const RECEIPT_TEXT_MAX = 200;
export const RECEIPT_NUMBER_MAX = 64;
export const RECEIPT_ADDRESS_MAX = 300;
export const RECEIPT_LIST_DEFAULT_LIMIT = 50;
export const RECEIPT_LIST_MAX_LIMIT = 100;

/** Suma unui bon/linie: întreg JSON 0..10^13 (CHECK-urile din 0008). */
const minorAmount = z.number().int().min(0).max(10_000_000_000_000, {
  message: "Suma este prea mare.",
});

/** Cantitatea: 1–9 cifre întregi, cel mult 3 zecimale, cu punct sau virgulă; > 0. */
const quantityText = z
  .string()
  .max(20)
  .transform((v) => v.trim().replace(",", "."))
  .refine((v) => /^[0-9]{1,9}(\.[0-9]{1,3})?$/.test(v) && !/^0+(\.0+)?$/.test(v), {
    message: "Cantitatea trebuie să fie un număr pozitiv, cu cel mult 3 zecimale.",
  });

/** Cota TVA în procente (`21`, `11`, `5.5`): 0..99,99. */
const vatRateText = z
  .string()
  .max(10)
  .transform((v) => v.trim().replace(",", ".").replace(/%$/, ""))
  .refine((v) => /^[0-9]{1,2}(\.[0-9]{1,2})?$/.test(v), {
    message: "Cota TVA e un procent între 0 și 99,99.",
  });

export const receiptLineInputSchema = z.strictObject({
  /** Linia existentă care se corectează (lipsă = linie nouă, adăugată de utilizator). */
  id: idSchema.optional(),
  rawName: z
    .string()
    .max(RECEIPT_TEXT_MAX * 2)
    .transform((v) => v.trim().replace(/\s+/g, " "))
    .refine((v) => v.length >= 1 && v.length <= RECEIPT_TEXT_MAX, {
      message: `Denumirea are între 1 și ${RECEIPT_TEXT_MAX} caractere.`,
    }),
  quantity: quantityText.nullable().optional(),
  unitPriceMinor: minorAmount.nullable().optional(),
  lineTotalMinor: minorAmount,
  vatRate: vatRateText.nullable().optional(),
  categoryId: idSchema.nullable().optional(),
  kind: z.enum(RECEIPT_LINE_KINDS),
});
export type ReceiptLineInput = z.infer<typeof receiptLineInputSchema>;

export const receiptPatchSchema = z
  .strictObject({
    merchantName: optionalText(RECEIPT_TEXT_MAX),
    merchantTaxId: z
      .string()
      .max(20)
      .transform((v) => v.trim())
      .nullable()
      .optional(),
    storeAddress: optionalText(RECEIPT_ADDRESS_MAX),
    receiptNumber: optionalText(RECEIPT_NUMBER_MAX),
    occurredOn: dateSchema.nullable().optional(),
    paymentMethod: z.enum(PAYMENT_METHODS).nullable().optional(),
    totalMinor: minorAmount.nullable().optional(),
    vatTotalMinor: minorAmount.nullable().optional(),
    /** Liniile, ÎNLOCUITE integral (ordinea din listă = poziția). */
    lines: z.array(receiptLineInputSchema).max(RECEIPT_MAX_LINES).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nimic de modificat." });
export type ReceiptPatch = z.infer<typeof receiptPatchSchema>;

export const receiptConfirmSchema = z.strictObject({
  /** Contul pe care se înregistrează cheltuiala (moneda lui = moneda bonului). */
  accountId: idSchema,
  /** Categoria tranzacției; lipsă = categoria cu cea mai mare sumă pe liniile bonului. */
  categoryId: idSchema.nullable().optional(),
  description: optionalText(RECEIPT_TEXT_MAX),
  notes: optionalText(1000),
  /** Data tranzacției; lipsă = data bonului. */
  occurredOn: dateSchema.optional(),
  /** Bonul e marcat „posibil duplicat”: salvarea cere confirmarea explicită. */
  allowDuplicate: z.boolean().optional(),
});
export type ReceiptConfirm = z.infer<typeof receiptConfirmSchema>;

const textFilter = z
  .string()
  .max(200)
  .transform((v) => v.trim().replace(/\s+/g, " "))
  .refine((v) => v.length >= 1 && v.length <= 100, { message: "Între 1 și 100 de caractere." });

export const receiptListSchema = z.strictObject({
  status: z.enum(RECEIPT_STATUSES).optional(),
  /** Căutare: magazin, produs (numele brut sau normalizat) sau sumă („45,90” / „45.90”). */
  q: textFilter.optional(),
  merchant: textFilter.optional(),
  dateFrom: dateSchema.optional(),
  dateTo: dateSchema.optional(),
  amountMinMinor: minorAmount.optional(),
  amountMaxMinor: minorAmount.optional(),
  categoryId: idSchema.optional(),
  tagId: idSchema.optional(),
  cursor: z.string().max(400).optional(),
  limit: z.number().int().min(1).max(RECEIPT_LIST_MAX_LIMIT).optional(),
});
export type ReceiptListQuery = z.infer<typeof receiptListSchema>;

// --- Cursorul (opac, nesemnat; ca la tranzacții, ADR 0004: mută doar poziția în propriile date) --

export type ReceiptCursor = Readonly<{ createdAt: string; id: string }>;

const cursorShape = z.strictObject({ v: z.literal(1), c: z.iso.datetime(), i: z.uuid() });

export function encodeReceiptCursor(c: ReceiptCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, c: c.createdAt, i: c.id }), "utf8").toString(
    "base64url",
  );
}

export function decodeReceiptCursor(raw: string): ReceiptCursor {
  const invalid = () => new ValidationError({ cursor: "Cursor invalid." });
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(raw)) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  const parsed = cursorShape.safeParse(value);
  if (!parsed.success) throw invalid();
  return { createdAt: parsed.data.c, id: parsed.data.i.toLowerCase() };
}

// --- Vederile ----------------------------------------------------------------------------------

export type ReceiptIssueView = Readonly<{
  code: IssueCode | string;
  field?: string;
  line?: number;
}>;

export type ReceiptLineView = Readonly<{
  id: string;
  position: number;
  rawName: string;
  normalizedName: string | null;
  quantity: string | null;
  unitPriceMinor: bigint | null;
  lineTotalMinor: bigint;
  vatRate: string | null;
  categoryId: string | null;
  kind: (typeof RECEIPT_LINE_KINDS)[number];
}>;

export type RemovedLineView = Readonly<{
  part: number;
  position: number;
  reason: "overlap";
  /** Numele de pe bon (curățat de worker), dacă e cunoscut. */
  name: string | null;
}>;

export type ReceiptView = Readonly<{
  id: string;
  status: (typeof RECEIPT_STATUSES)[number];
  documentIds: readonly string[];
  batchId: string | null;
  merchantName: string | null;
  merchantTaxId: string | null;
  storeAddress: string | null;
  receiptNumber: string | null;
  occurredOn: string | null;
  paymentMethod: (typeof PAYMENT_METHODS)[number] | null;
  totalMinor: bigint | null;
  vatTotalMinor: bigint | null;
  currency: Currency;
  confidence: number | null;
  providerUsed: (typeof AI_PROVIDERS_USED)[number];
  fallbackReason: (typeof FALLBACK_REASONS)[number] | null;
  transactionId: string | null;
  duplicateOfReceiptId: string | null;
  issues: readonly ReceiptIssueView[];
  /** Suma liniilor cu semn (reducerile scad), calculată în cod; `null` fără linii. */
  linesSumMinor: bigint | null;
  /** Categoriile distincte ale liniilor (lista: „toate categoriile bonului”). */
  categoryIds: readonly string[];
  lineCount: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export type ReceiptDetail = ReceiptView &
  Readonly<{
    lines: readonly ReceiptLineView[];
    /** Bonul lung: liniile eliminate la unire (suprapunere), cu poza și poziția. */
    removedLines: readonly RemovedLineView[];
    removedCount: number;
    /** Bonul lung în ordine greșită: ordinea propusă („Ordonează automat”), pozele 1..4. */
    suggestedOrder: readonly number[] | null;
  }>;

export type ReceiptPage = Readonly<{ data: ReceiptView[]; nextCursor: string | null }>;

/** `bigint` → număr JSON exact (sumele bonului ≤ 10^13; suma liniilor ≤ 5 · 10^15 < 2^53). */
function safe(n: bigint): number {
  if (n > MAX_JSON_SAFE_MINOR || n < -MAX_JSON_SAFE_MINOR) throw new MoneyOverflowError(n);
  return Number(n);
}
const safeOrNull = (n: bigint | null) => (n === null ? null : safe(n));

export function receiptToJson(r: ReceiptView) {
  return {
    id: r.id,
    status: r.status,
    documentIds: [...r.documentIds],
    batchId: r.batchId,
    merchantName: r.merchantName,
    merchantTaxId: r.merchantTaxId,
    storeAddress: r.storeAddress,
    receiptNumber: r.receiptNumber,
    occurredOn: r.occurredOn,
    paymentMethod: r.paymentMethod,
    totalMinor: safeOrNull(r.totalMinor),
    vatTotalMinor: safeOrNull(r.vatTotalMinor),
    currency: r.currency,
    confidence: r.confidence,
    providerUsed: r.providerUsed,
    fallbackReason: r.fallbackReason,
    transactionId: r.transactionId,
    duplicateOfReceiptId: r.duplicateOfReceiptId,
    issues: r.issues.map((i) => ({
      code: i.code,
      ...(i.field !== undefined ? { field: i.field } : {}),
      ...(i.line !== undefined ? { line: i.line } : {}),
    })),
    linesSumMinor: safeOrNull(r.linesSumMinor),
    categoryIds: [...r.categoryIds],
    lineCount: r.lineCount,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
export type ReceiptJson = ReturnType<typeof receiptToJson>;

export function receiptLineToJson(l: ReceiptLineView) {
  return {
    id: l.id,
    position: l.position,
    rawName: l.rawName,
    normalizedName: l.normalizedName,
    quantity: l.quantity,
    unitPriceMinor: safeOrNull(l.unitPriceMinor),
    lineTotalMinor: safe(l.lineTotalMinor),
    vatRate: l.vatRate,
    categoryId: l.categoryId,
    kind: l.kind,
  };
}
export type ReceiptLineJson = ReturnType<typeof receiptLineToJson>;

export function receiptDetailToJson(r: ReceiptDetail) {
  return {
    ...receiptToJson(r),
    lines: r.lines.map(receiptLineToJson),
    removedLines: r.removedLines.map((x) => ({ ...x })),
    removedCount: r.removedCount,
    suggestedOrder: r.suggestedOrder === null ? null : [...r.suggestedOrder],
  };
}
export type ReceiptDetailJson = ReturnType<typeof receiptDetailToJson>;
