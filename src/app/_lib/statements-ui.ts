import {
  type Currency,
  InvalidAmountError,
  MoneyOverflowError,
  parseAmount,
  toJson,
} from "@/lib/money";
import { ro } from "@/messages/ro";

import { formatDate } from "./planning-ui";

/**
 * Ajutoarele interfeței extraselor (F7-B): texte pentru coduri fixe, etichetele acoperirii,
 * construirea mapării de coloane din formular și suma în cealaltă monedă a unui schimb. Funcții
 * pure (fără React), testate în `statements-ui.test.ts`.
 */

const t = ro.statements;

/** Mesajul unui cod de eroare al extrasului (necunoscut → mesajul generic, fără ecou). */
export function statementErrorText(code: string | null | undefined): string {
  return (code && t.errors[code]) || t.genericError;
}

/** Avertismentele cunoscute (cele necunoscute se omit: nu afișăm coduri brute). */
export function warningTexts(codes: readonly string[]): string[] {
  return codes.flatMap((c) => (t.warnings[c] ? [t.warnings[c]!] : []));
}

export type CoverageCellJson = Readonly<{
  month: string;
  status: "complete" | "partial" | "missing";
  coveredUntil: string | null;
  fromStart: boolean;
}>;

export function coverageLabel(c: CoverageCellJson): string {
  const c2 = ro.coverage;
  if (c.status === "complete") return c2.complete;
  if (c.status === "missing") return c2.missing;
  const until = formatDate(c.coveredUntil ?? "");
  return c.fromStart ? c2.partial(until) : c2.partialGaps(until);
}

/** `2026-10` → `10.2026`. */
export function formatMonth(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  return m ? `${m[2]}.${m[1]}` : month;
}

/** Ultimele `n` luni (inclusiv luna lui `today`), cele mai vechi primele. */
export function lastMonths(today: string, n: number): { from: string; to: string } {
  const y = Number(today.slice(0, 4));
  const mo = Number(today.slice(5, 7));
  const index = y * 12 + (mo - 1) - (n - 1);
  const from = `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
  return { from, to: today.slice(0, 7) };
}

export type MappingForm = Readonly<{
  headerRow: string;
  date: string;
  dateFormat: string;
  mode: "signed" | "split";
  amount: string;
  debit: string;
  credit: string;
  negativeIs: "debit" | "credit";
  decimal: "," | ".";
  thousands: "." | "," | " " | "";
  description: string;
  reference: string;
  balance: string;
}>;

const col = (v: string): number | undefined => (/^\d{1,2}$/.test(v) ? Number(v) : undefined);

/** Maparea trimisă serverului (care o validează strict); câmpurile goale lipsesc. */
export function mappingFromForm(f: MappingForm): Record<string, unknown> {
  const out: Record<string, unknown> = {
    headerRow: /^-?\d{1,2}$/.test(f.headerRow) ? Number(f.headerRow) : 0,
    date: col(f.date),
    dateFormat: f.dateFormat,
    decimal: f.decimal,
    thousands: f.thousands,
    description: col(f.description) === undefined ? [] : [col(f.description)],
  };
  if (f.mode === "signed") {
    out.amount = col(f.amount);
    out.negativeIs = f.negativeIs;
  } else {
    out.debit = col(f.debit);
    out.credit = col(f.credit);
  }
  if (col(f.reference) !== undefined) out.reference = col(f.reference);
  if (col(f.balance) !== undefined) out.balance = col(f.balance);
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** Formularul precompletat din sugestia serverului. */
export function formFromSuggestion(m: Readonly<Record<string, unknown>>): MappingForm {
  const s = (v: unknown) => (typeof v === "number" ? String(v) : "");
  const desc = Array.isArray(m.description) ? m.description[0] : undefined;
  return {
    headerRow: s(m.headerRow ?? 0),
    date: s(m.date),
    dateFormat: typeof m.dateFormat === "string" ? m.dateFormat : "dmy_dot",
    mode: m.debit !== undefined || m.credit !== undefined ? "split" : "signed",
    amount: s(m.amount),
    debit: s(m.debit),
    credit: s(m.credit),
    negativeIs: m.negativeIs === "credit" ? "credit" : "debit",
    decimal: m.decimal === "." ? "." : ",",
    thousands: m.thousands === "." || m.thousands === "," || m.thousands === " " ? m.thousands : "",
    description: s(desc),
    reference: s(m.reference),
    balance: s(m.balance),
  };
}

/**
 * Suma introdusă pentru cealaltă monedă a unui schimb (`10,00`) → unități minore (întreg JSON,
 * prin `toJson`, care verifică plafonul 2^53), sau `null`. Fără aritmetică float.
 */
export function counterAmountMinor(text: string, currency: Currency): number | null {
  try {
    const m = parseAmount(text.trim(), currency);
    if (m.amountMinor <= 0n) return null;
    return toJson(m).amountMinor;
  } catch (error) {
    if (error instanceof InvalidAmountError || error instanceof MoneyOverflowError) return null;
    throw error;
  }
}
