import { z } from "zod";

import { TRANSACTION_SOURCES, TRANSACTION_TYPES, TRANSFER_DIRECTIONS } from "@/db/schema";
import { ValidationError } from "@/lib/errors";
import { type Currency, money, toJson } from "@/lib/money";
import {
  amountTextSchema,
  dateSchema,
  idSchema,
  isCalendarDate,
  notBoth,
  optionalText,
  positiveMinorSchema,
} from "@/modules/ledger/input";

/** Tranzacțiile (5.1, 5.2, 6.1, 6.4). Zod strict: `householdId`, `currency`, `source` respinse. */

export const DESCRIPTION_MAX = 500;
export const MERCHANT_MAX = 200;
export const NOTES_MAX = 2000;
/** Limita implicită și plafonul paginării (o valoare mai mare se reduce la plafon). */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

/** Prin serviciul de tranzacții se creează doar venituri și cheltuieli; transferurile separat. */
export const ENTRY_TYPES = ["income", "expense"] as const;

const amountRefine = {
  message: "Trimite suma o singură dată (amountMinor sau amount).",
} as const;

export const transactionCreateSchema = z
  .strictObject({
    accountId: idSchema,
    type: z.enum(ENTRY_TYPES),
    amountMinor: positiveMinorSchema.optional(),
    amount: amountTextSchema.optional(),
    occurredOn: dateSchema,
    categoryId: idSchema.nullable().optional(),
    description: optionalText(DESCRIPTION_MAX),
    merchant: optionalText(MERCHANT_MAX),
    notes: optionalText(NOTES_MAX),
  })
  .refine(notBoth, amountRefine);

export const transactionUpdateSchema = z
  .strictObject({
    accountId: idSchema.optional(),
    type: z.enum(ENTRY_TYPES).optional(),
    amountMinor: positiveMinorSchema.optional(),
    amount: amountTextSchema.optional(),
    occurredOn: dateSchema.optional(),
    categoryId: idSchema.nullable().optional(),
    description: optionalText(DESCRIPTION_MAX),
    merchant: optionalText(MERCHANT_MAX),
    notes: optionalText(NOTES_MAX),
  })
  .refine(notBoth, amountRefine)
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nimic de modificat.",
  });

export const TRANSACTION_SORTS = ["date_desc", "date_asc", "amount_desc", "amount_asc"] as const;
export type TransactionSort = (typeof TRANSACTION_SORTS)[number];

export const transactionListSchema = z
  .strictObject({
    q: z
      .string()
      .max(200)
      .transform((v) => v.trim())
      .optional(),
    accountId: idSchema.optional(),
    categoryId: idSchema.optional(),
    type: z.enum(TRANSACTION_TYPES).optional(),
    source: z.enum(TRANSACTION_SOURCES).optional(),
    dateFrom: dateSchema.optional(),
    dateTo: dateSchema.optional(),
    amountMinMinor: positiveMinorSchema.optional(),
    amountMaxMinor: positiveMinorSchema.optional(),
    sort: z.enum(TRANSACTION_SORTS).optional(),
    cursor: z.string().max(400).optional(),
    limit: z.number().int().min(1).optional(),
  })
  .refine((v) => !v.dateFrom || !v.dateTo || v.dateFrom <= v.dateTo, {
    message: "Intervalul de date e inversat.",
  })
  .refine(
    (v) =>
      v.amountMinMinor === undefined ||
      v.amountMaxMinor === undefined ||
      v.amountMinMinor <= v.amountMaxMinor,
    { message: "Intervalul de sume e inversat." },
  )
  .optional();

export type TransactionListQuery = z.output<typeof transactionListSchema>;

// ---------------------------------------------------------------------------------------------
// Cursorul de paginare (6.1, 6.4): opac pentru client, dar NU secret. Conține doar poziția (cheia
// de sortare + id-ul ultimului rând), codificată base64url(JSON), și e validat strict la decodare.
// Nu e semnat (decizia mea, ADR 0004): un cursor modificat poate muta doar poziția în propriile
// date, pentru că filtrele și gospodăria vin din cerere și din sesiune, iar RLS izolează rândurile.
// ---------------------------------------------------------------------------------------------

export type Cursor = Readonly<{ sort: TransactionSort; key: string; id: string }>;

const cursorSchema = z.strictObject({
  v: z.literal(1),
  s: z.enum(TRANSACTION_SORTS),
  k: z.string().max(40),
  i: z.uuid(),
});

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify({ v: 1, s: c.sort, k: c.key, i: c.id }), "utf8").toString(
    "base64url",
  );
}

/** Decodează și validează cursorul pentru sortarea cerută; altfel `ValidationError`. */
export function decodeCursor(raw: string, sort: TransactionSort): Cursor {
  const invalid = () => new ValidationError({ cursor: "Cursor invalid." });
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(raw)) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  const parsed = cursorSchema.safeParse(value);
  if (!parsed.success || parsed.data.s !== sort) throw invalid();
  const { k } = parsed.data;
  const isDate = sort.startsWith("date_");
  // Suma în cursor e text cu cifre (niciodată număr JSON), ca să nu treacă prin float.
  if (isDate ? !isCalendarDate(k) : !/^[1-9][0-9]{0,18}$/.test(k)) throw invalid();
  if (!isDate && BigInt(k) > 9_223_372_036_854_775_807n) throw invalid();
  return { sort, key: k, id: parsed.data.i.toLowerCase() };
}

// ---------------------------------------------------------------------------------------------
// Forma de ieșire
// ---------------------------------------------------------------------------------------------

export type TransactionView = Readonly<{
  id: string;
  accountId: string;
  categoryId: string | null;
  type: (typeof TRANSACTION_TYPES)[number];
  amountMinor: bigint;
  currency: Currency;
  occurredOn: string;
  description: string | null;
  merchant: string | null;
  notes: string | null;
  source: (typeof TRANSACTION_SOURCES)[number];
  transferGroupId: string | null;
  transferDirection: (typeof TRANSFER_DIRECTIONS)[number] | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type TransactionPage = Readonly<{ data: TransactionView[]; nextCursor: string | null }>;

export type TransactionJson = Omit<TransactionView, "amountMinor" | "createdAt" | "updatedAt"> & {
  amountMinor: number;
  createdAt: string;
  updatedAt: string;
};

/** JSON (6.4): `amountMinor` întreg; peste 2^53 `toJson` aruncă `MoneyOverflowError`. */
export function transactionToJson(t: TransactionView): TransactionJson {
  return {
    ...t,
    amountMinor: toJson(money(t.amountMinor, t.currency)).amountMinor,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}
