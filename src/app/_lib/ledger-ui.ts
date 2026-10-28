/**
 * Ajutoarele interfeței registrului (F2-C), comune serverului și browserului. Funcții pure, fără
 * React și fără module de server: banii trec DOAR prin `src/lib/money.ts` (`parseAmount`,
 * `formatMoney`, `toJson`/`fromJson`), niciodată prin float.
 */

import {
  type Currency,
  InvalidAmountError,
  MoneyError,
  formatMoney,
  fromJson,
  isCurrency,
  parseAmount,
  toDecimalString,
  toJson,
} from "@/lib/money";
import { ro } from "@/messages/ro";

import type { ApiResult } from "./api-client";
import { formatDate } from "./planning-ui";

// ---------------------------------------------------------------------------------------------
// Sume
// ---------------------------------------------------------------------------------------------

/** Suma din API (`amountMinor` întreg JSON) formatată românește: `1.234,56 lei`. */
export function formatMinor(amountMinor: number, currency: Currency): string {
  return formatMoney(fromJson({ amountMinor, currency }));
}

/** Suma cu semn pentru o tranzacție: cheltuiala cu „−”, venitul cu „+”, transferul fără semn. */
export function formatSigned(
  type: "income" | "expense" | "transfer",
  amountMinor: number,
  currency: Currency,
): string {
  const text = formatMinor(amountMinor, currency);
  if (type === "expense") return `−${text}`;
  if (type === "income") return `+${text}`;
  return text;
}

export type AmountParse =
  Readonly<{ ok: true; amountMinor: number }> | Readonly<{ ok: false; message: string }>;

/**
 * Textul scris de utilizator → `amountMinor` (întreg sigur), prin `parseAmount` + `toJson`. Valorile
 * ambigue (`1.234`) și formele invalide dau mesajul din `ro.ledger.amountErrors`.
 */
export function parseAmountInput(
  text: string,
  currency: Currency,
  options: Readonly<{ allowNegative?: boolean; positive?: boolean }> = {},
): AmountParse {
  try {
    const value = parseAmount(text, currency, { allowNegative: options.allowNegative ?? false });
    if (options.positive && value.amountMinor <= 0n) {
      return { ok: false, message: ro.ledger.amountErrors.not_positive! };
    }
    return { ok: true, amountMinor: toJson(value).amountMinor };
  } catch (error) {
    if (error instanceof InvalidAmountError) {
      return {
        ok: false,
        message: ro.ledger.amountErrors[error.reason] ?? ro.ledger.amountErrors.invalid_format!,
      };
    }
    if (error instanceof MoneyError) {
      return { ok: false, message: ro.ledger.amountErrors.invalid_format! };
    }
    throw error;
  }
}

/** Suma din API afișată într-un câmp de editare: `1234,56` (fără grupare, cu virgulă). */
export function amountInputValue(amountMinor: number, currency: Currency): string {
  return toDecimalString(fromJson({ amountMinor, currency })).replace(".", ",");
}

export function asCurrency(value: string): Currency {
  return isCurrency(value) ? value : "RON";
}

// ---------------------------------------------------------------------------------------------
// Erorile API (6.4)
// ---------------------------------------------------------------------------------------------

export type FormErrors = Readonly<{
  form: string | null;
  fields: Readonly<Record<string, string>>;
}>;

export const NO_ERRORS: FormErrors = { form: null, fields: {} };

/**
 * Mesajul general și mesajele pe câmp pentru un răspuns eșuat. Mesajele de câmp vin de la server
 * (fixe, în română, fără ecoul valorii); mesajul general se alege după `code`/`reason`.
 */
export function apiErrors(result: Pick<ApiResult, "status" | "error">): FormErrors {
  const e = ro.ledger.errors;
  const fields = { ...(result.error?.fields ?? {}) };
  if (result.status === 0) return { form: e.network, fields: {} };
  if (result.status === 400) {
    const root = fields._;
    delete fields._;
    return { form: root ?? e.invalid, fields };
  }
  if (result.status === 404) return { form: e.notFound, fields: {} };
  if (result.status === 429) return { form: e.rateLimited, fields: {} };
  if (result.status === 409) {
    const reason = result.error?.reason ?? "";
    if (reason === "request_in_progress") return { form: e.inProgress, fields: {} };
    return { form: e.reasons[reason] ?? e.generic, fields: {} };
  }
  return { form: e.generic, fields: {} };
}

// ---------------------------------------------------------------------------------------------
// Date calendaristice (5.2)
// ---------------------------------------------------------------------------------------------

export const APP_TIME_ZONE = "Europe/Bucharest";

/** Data de azi `YYYY-MM-DD` în fusul dat (implicit `Europe/Bucharest`). */
export function todayIn(timeZone = APP_TIME_ZONE, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * `2026-10-28` → `28.10.2026` (master prompt 5.3; Faza 4: același format ca planificarea, din
 * cifre, fără fus și fără locale). Delegă la `formatDate` din `planning-ui.ts`, sursa unică.
 */
export function formatCalendarDate(value: string): string {
  return formatDate(value);
}
