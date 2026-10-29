import { type Currency, parseAmount } from "@/lib/money";
import { cleanText } from "@/modules/receipts/normalize";

import { STATEMENT_DESCRIPTION_MAX, STATEMENT_REFERENCE_MAX } from "@/db/schema/statements";

import { StatementError, type TextItem } from "./types";

/**
 * Funcții pure comune parserelor de extrase (ADR 0018): rânduri din elemente poziționale, sume și
 * date în formatele EXPLICITE ale fiecărei bănci, normalizarea descrierilor.
 */

// ---------------------------------------------------------------------------------------------
// Rânduri
// ---------------------------------------------------------------------------------------------

export type Row = Readonly<{ p: number; y: number; items: readonly TextItem[] }>;

/** Toleranța pe verticală la gruparea fragmentelor în rânduri (unități PDF). */
export const ROW_TOLERANCE = 2.5;

/**
 * Grupează elementele în rânduri: pagină crescător, y descrescător (de sus în jos), x crescător.
 * Două fragmente sunt pe același rând dacă diferența pe y e ≤ `ROW_TOLERANCE` față de primul
 * fragment al rândului (sumele aliniate la dreapta stau uneori cu 1–2 unități mai sus/jos).
 */
export function groupRows(items: readonly TextItem[]): Row[] {
  const sorted = items
    .filter((i) => i.s.trim() !== "")
    .slice()
    .sort((a, b) => a.p - b.p || b.y - a.y || a.x - b.x);
  const rows: { p: number; y: number; items: TextItem[] }[] = [];
  for (const it of sorted) {
    const last = rows[rows.length - 1];
    if (last && last.p === it.p && Math.abs(last.y - it.y) <= ROW_TOLERANCE) last.items.push(it);
    else rows.push({ p: it.p, y: it.y, items: [it] });
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  return rows;
}

export const rowText = (r: Row): string => r.items.map((i) => i.s.trim()).join(" ");
export const centre = (i: TextItem): number => i.x + i.w / 2;

/** Textul curățat al unui fragment (fără control/NUL/bidi, NFC, spații comprimate). */
export function cleanItemText(s: string): string {
  return cleanText(s, 2000) ?? "";
}

/** Elementele curățate; fragmentele goale după curățare dispar. */
export function cleanItems(items: readonly TextItem[]): TextItem[] {
  const out: TextItem[] = [];
  for (const i of items) {
    const s = cleanItemText(i.s);
    if (s !== "") out.push({ ...i, s });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Sume: formatul fiecărei bănci, explicit (fără euristici „1.004”)
// ---------------------------------------------------------------------------------------------

/** `comma_dot`: `1,234.56` (BT, Raiffeisen); `dot_comma`: `1.234,56` (BRD, Revolut). */
export type AmountStyle = "comma_dot" | "dot_comma";

const AMOUNT_RE: Readonly<Record<AmountStyle, RegExp>> = {
  comma_dot: /^(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/,
  dot_comma: /^(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})$/,
};

/** E o sumă în stilul dat (exact două zecimale, grupare corectă)? */
export function isAmount(text: string, style: AmountStyle): boolean {
  return AMOUNT_RE[style].test(text.trim());
}

/**
 * Suma în unități minore (bigint), din textul în stilul explicit al băncii. Forma canonică
 * (`1234,56`) trece prin `parseAmount` (src/lib/money.ts), deci fără float și cu plafonul 2^53.
 */
export function parseStatementAmount(
  text: string,
  style: AmountStyle,
  currency: Currency,
  allowNegative = false,
): bigint {
  let s = text.trim();
  let negative = false;
  if (allowNegative && (s.startsWith("-") || s.startsWith("−"))) {
    negative = true;
    s = s.slice(1).trim();
  }
  const m = AMOUNT_RE[style].exec(s);
  if (!m) throw new StatementError("invalid_amount");
  const integer = m[1]!.replace(/[.,]/g, "");
  try {
    const v = parseAmount(`${integer},${m[2]}`, currency).amountMinor;
    if (v > 10_000_000_000_000n) throw new StatementError("invalid_amount");
    return negative ? -v : v;
  } catch {
    throw new StatementError("invalid_amount");
  }
}

// ---------------------------------------------------------------------------------------------
// Date
// ---------------------------------------------------------------------------------------------

function isoDate(y: number, m: number, d: number): string {
  if (!(y >= 1900 && y <= 2999 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) {
    throw new StatementError("invalid_date");
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new StatementError("invalid_date");
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** `dd/mm/yyyy` sau `dd.mm.yyyy` (separatorul dat explicit). */
export function parseDmy(text: string, sep: "/" | "."): string {
  const re = sep === "/" ? /^(\d{2})\/(\d{2})\/(\d{4})$/ : /^(\d{2})\.(\d{2})\.(\d{4})$/;
  const m = re.exec(text.trim());
  if (!m) throw new StatementError("invalid_date");
  return isoDate(Number(m[3]), Number(m[2]), Number(m[1]));
}

export const isDmy = (text: string, sep: "/" | "."): boolean =>
  (sep === "/" ? /^\d{2}\/\d{2}\/\d{4}$/ : /^\d{2}\.\d{2}\.\d{4}$/).test(text.trim());

/** Lunile în română: abrevierile Revolut (`oct.`, `sept.`) și numele întregi. */
const RO_MONTHS: ReadonlyArray<readonly string[]> = [
  ["ian", "ianuarie"],
  ["feb", "februarie"],
  ["mar", "martie"],
  ["apr", "aprilie"],
  ["mai"],
  ["iun", "iunie"],
  ["iul", "iulie"],
  ["aug", "august"],
  ["sep", "sept", "septembrie"],
  ["oct", "octombrie"],
  ["noi", "nov", "noiembrie"],
  ["dec", "decembrie"],
];

function monthIndex(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  const i = RO_MONTHS.findIndex((names) => names.includes(w));
  if (i < 0) throw new StatementError("invalid_date");
  return i + 1;
}

const RO_DATE_RE = /^(\d{1,2}) ([a-zA-Z]{3,10}\.?) (\d{4})$/;

/** `3 nov. 2026`, `1 octombrie 2026`. */
export function parseRoDate(text: string): string {
  const m = RO_DATE_RE.exec(text.trim());
  if (!m) throw new StatementError("invalid_date");
  return isoDate(Number(m[3]), monthIndex(m[2]!), Number(m[1]));
}

export const isRoDate = (text: string): boolean => {
  const m = RO_DATE_RE.exec(text.trim());
  if (!m) return false;
  try {
    monthIndex(m[2]!);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

/** Fără diacritice, litere mici, spații comprimate: pentru potriviri de antete și deduplicare. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Reparația encodării defectuoase a fontului Raiffeisen (diacriticele apar ca simboluri ASCII:
 * `Dat\`` = Dată, `ini]ial` = inițial, `Bucure[ti` = București). Se aplică DOAR după ce banca a
 * fost detectată (pe cuvinte fără diacritice), altfel ar strica `[`, `]`, `` ` `` din descrierile
 * altor bănci. Majusculele (`~ } {`) urmează aceeași schemă (decizia mea; neîntâlnite în extras).
 */
const RAIFFEISEN_MAP: Readonly<Record<string, string>> = {
  "`": "ă",
  "]": "ț",
  "[": "ș",
  "~": "Ă",
  "}": "Ț",
  "{": "Ș",
};

export function repairRaiffeisen(s: string): string {
  return s.replace(/[`\][~{}]/g, (c) => RAIFFEISEN_MAP[c] ?? c);
}

// IBAN-uri (cu sau fără spații, litere mari sau mici, TĂIATE peste rândurile de continuare: între
// grupuri poate apărea separatorul „ · ” al rândurilor unite) și numere de card mascate: eliminate
// din descrierile stocate (revizuirea F7-A). Se aplică DUPĂ unirea rândurilor.
const GAP = "(?:\\s?·\\s?|\\s)?";
const IBAN_RE = new RegExp(
  `(?<![A-Za-z0-9])[A-Za-z]{2}\\d{2}(?:${GAP}[A-Za-z0-9]{4}){3,7}(?:\\s?\\d[A-Za-z0-9]{0,3})?(?![A-Za-z0-9])`,
  "g",
);
const CARD_RE = /\b\d{4,6}[*X.]{4,}\d{4}\b|\b(?:X{4} ){3}\d{4}\b|\.{3,}\d{4}\b/gi;
const CNP_RE = /\bCNP\/CF:\s*\S+/gi;
const SEP = " · ";

/**
 * Descrierea stocată: rândurile unite cu „ · ”, fără IBAN-uri, numere de card și CNP-uri
 * (decizia mea, ADR 0018: rămân numele contrapărții și detaliile utile), plafonată la 500.
 */
export function buildDescription(parts: readonly string[]): string {
  const joined = parts
    .map((p) => p.replace(CNP_RE, "").replace(CARD_RE, "").trim())
    .filter((p) => p !== "")
    .join(SEP)
    .replace(IBAN_RE, " ");
  const cleaned = joined
    .split("·")
    .map((p) =>
      p
        .replace(/\s{2,}/g, " ")
        .trim()
        .replace(/[,;]\s*$/, "")
        .trim(),
    )
    .filter((p) => p !== "")
    .join(SEP);
  const chars = Array.from(cleanText(cleaned, STATEMENT_DESCRIPTION_MAX) ?? "");
  return chars.slice(0, STATEMENT_DESCRIPTION_MAX).join("") || "—";
}

/** Referința bancară curățată și plafonată (sau `null`). */
export function cleanReference(s: string | null | undefined): string | null {
  if (!s) return null;
  return cleanText(s, STATEMENT_REFERENCE_MAX);
}

/** Descrierea normalizată pentru cheia de deduplicare (fără diacritice, spații, punctuație). */
export function normalizeForDedup(s: string): string {
  return fold(s)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
