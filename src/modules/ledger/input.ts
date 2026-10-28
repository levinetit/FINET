import { z } from "zod";

import { ValidationError } from "@/lib/errors";
import { type Currency, InvalidAmountError, MoneyError, fromJson, parseAmount } from "@/lib/money";

/**
 * Validarea comună a intrărilor registrului (conturi, categorii, tranzacții, transferuri).
 * Serviciile primesc `unknown` și îl validează aici (Zod strict: o cheie necunoscută, de exemplu
 * `householdId`, e respinsă), pentru că sunt apelate atât din API (F2-B), cât și din server
 * actions (F2-C). Mesajele sunt fixe și nu repetă valoarea primită.
 */

/** Mesajele de câmp din erorile Zod (aceeași regulă ca `fieldsOf` din handlerele `/api/v1/me`). */
export function zodFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  let root: string | null = null;
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const k of issue.keys) fields[[...issue.path, k].join(".")] = "Câmp nepermis.";
    } else if (issue.path.length === 0) {
      root ??= issue.code === "custom" ? issue.message : "Valoare invalidă.";
    } else {
      fields[issue.path.join(".")] ??=
        issue.code === "custom" ? issue.message : "Valoare invalidă.";
    }
  }
  if (root !== null && Object.keys(fields).length === 0) fields._ = root;
  return fields;
}

/** Validează `input` cu `schema`; altfel `ValidationError` cu mesajele pe câmp. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ValidationError(zodFields(parsed.error));
  return parsed.data;
}

export const idSchema = z.uuid().transform((v) => v.toLowerCase());

/** Validează un id venit din rută; un id invalid e tratat ca resursă inexistentă de apelant. */
export function isValidId(value: unknown): value is string {
  return z.uuid().safeParse(value).success;
}

/**
 * Data calendaristică locală `YYYY-MM-DD` (5.2): fără oră și fără fus orar; verificată ca dată
 * reală (de exemplu `2026-02-30` e respinsă), în intervalul 1900–2999 (ca CHECK-ul din bază).
 */
export function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2999 || mo < 1 || mo > 12 || d < 1) return false;
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= days;
}

export const dateSchema = z
  .string()
  .refine(isCalendarDate, { message: "Data trebuie să fie de forma AAAA-LL-ZZ." });

/** Un întreg JSON sigur (sub 2^53), strict pozitiv: o sumă în unități minore. */
export const positiveMinorSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER, { message: "Suma este prea mare." });

/** Un întreg JSON sigur, cu orice semn (soldul inițial poate fi negativ). */
export const signedMinorSchema = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

/** Textul unei sume scrise de utilizator (`1.234,56`), parsat cu `parseAmount`. */
export const amountTextSchema = z.string().min(1).max(40);

/** Text liber opțional: spațiile de la capete se elimină, iar textul gol devine `null`. */
export function optionalText(max: number) {
  return z
    .string()
    .max(max * 2)
    .transform((v) => v.trim())
    .refine((v) => v.length <= max, { message: `Cel mult ${max} caractere.` })
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();
}

/** Numele obligatoriu (cont, categorie): fără spații la capete, 1..max caractere. */
export function requiredName(max: number) {
  return z
    .string()
    .max(max * 2)
    .transform((v) => v.trim().replace(/\s+/g, " "))
    .refine((v) => v.length >= 1 && v.length <= max, {
      message: `Numele are între 1 și ${max} caractere.`,
    });
}

/**
 * Suma dintr-o intrare care are fie `amountMinor` (întreg JSON, 6.4), fie `amount` (text scris de
 * utilizator, 5.3), în moneda dată. Rezultatul e `bigint` > 0; float-ul nu apare nicăieri.
 */
export function resolvePositiveAmount(
  input: Readonly<{ amountMinor?: number; amount?: string }>,
  currency: Currency,
  field = "amountMinor",
): bigint {
  const value = resolveAmount(input, currency, field, false);
  if (value <= 0n) throw new ValidationError({ [field]: "Suma trebuie să fie pozitivă." });
  return value;
}

/** Ca `resolvePositiveAmount`, dar acceptă și negativ și zero (soldul inițial). */
export function resolveAmount(
  input: Readonly<{ amountMinor?: number; amount?: string }>,
  currency: Currency,
  field: string,
  allowNegative: boolean,
): bigint {
  try {
    if (input.amountMinor !== undefined) {
      return fromJson({ amountMinor: input.amountMinor, currency }).amountMinor;
    }
    if (input.amount !== undefined) {
      const textField = field.endsWith("Minor") ? field.slice(0, -"Minor".length) : field;
      try {
        return parseAmount(input.amount, currency, { allowNegative }).amountMinor;
      } catch (error) {
        if (error instanceof InvalidAmountError) {
          throw new ValidationError({ [textField]: error.message });
        }
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof MoneyError) throw new ValidationError({ [field]: "Sumă invalidă." });
    throw error;
  }
  throw new ValidationError({ [field]: "Introdu o sumă." });
}

/** Cel mult una dintre `amountMinor` și `amount`. */
export function notBoth(v: { amountMinor?: number; amount?: string }): boolean {
  return v.amountMinor === undefined || v.amount === undefined;
}
