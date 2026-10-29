import type { Currency } from "@/lib/money";

import { type Columns, amountItems, columnOf, findColumns, stripSuffix } from "../table";
import {
  centre,
  fold,
  groupRows,
  isRoDate,
  parseRoDate,
  parseStatementAmount,
  rowText,
} from "../text";
import { type ParsedStatement, StatementError, type TextItem } from "../types";
import { type Draft, currencyFrom, currencyFromSymbol, finalizeLines, ibanLast4 } from "./common";

/**
 * Revolut (PDF, un cont pe monedă: `Extras RON`). Antet `Rezumatul soldului` (`Produs | Sold
 * inițial | Sume retrase | Sume adăugate | Sold final`), perioada `Tranzacții din cont de la …
 * până la …`, tabel `Dată | Descriere | Sume retrase | Sume adăugate | Sold` (soldul după
 * fiecare rând). Date `3 nov. 2026`, sume `9.876,54 RON`. Sub fiecare rând: `Referință: …`,
 * `ID tranzacție: …` (identificatorul UNIC al băncii → deduplicare), contrapartea (`De la:`/
 * `Către:`), `Card: …`. `Schimbat în EUR` = schimb valutar (transfer între conturile pe monede),
 * cu suma în cealaltă monedă pe rândul următor (`10,00€`). O secțiune de tranzacții „în așteptare”
 * se numără, nu se importă.
 */
export const REVOLUT_PARSER_VERSION = 1;
const STYLE = "dot_comma" as const;
const SUFFIX = /\s?(RON|EUR|USD|GBP|CHF|[€$£])$/;
const FX_AMOUNT_RE = /^(?:[€$]\s?)?(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})\s?(?:€|\$|RON|EUR|USD)?$/;

export function parseRevolut(raw: readonly TextItem[]): ParsedStatement {
  const rows = groupRows(raw);
  let currency: Currency | null = null;
  let last4: string | null = null;
  let summaryCols: { opening: number; closing: number } | null = null;
  let opening: bigint | null = null;
  let closing: bigint | null = null;
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  let cols: Columns | null = null;
  const drafts: Draft[] = [];
  let current: Draft | null = null;
  let pending = false;
  let pendingCount = 0;

  const amount = (it: TextItem): bigint => {
    const sfx = SUFFIX.exec(it.s.trim())?.[1];
    if (sfx && currency && currencyFromSymbol(sfx) !== currency) {
      throw new StatementError("currency_mismatch");
    }
    return parseStatementAmount(stripSuffix(it.s, SUFFIX), STYLE, currency ?? "RON");
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const text = fold(rowText(row));

    const title = /^extras ([a-z]{3})$/.exec(text);
    if (title) {
      const c = currencyFrom(title[1]!);
      if (currency && currency !== c) throw new StatementError("currency_mismatch");
      currency = c;
      continue;
    }
    const ibanIdx = row.items.findIndex((it) => it.s.trim() === "IBAN");
    if (ibanIdx >= 0 && !cols) {
      last4 = ibanLast4(row.items[ibanIdx + 1]?.s);
      continue;
    }
    if (text.startsWith("produs ") && text.includes("sold initial")) {
      const o = row.items.find((it) => fold(it.s) === "sold initial");
      const c = row.items.find((it) => fold(it.s) === "sold final");
      if (!o || !c) throw new StatementError("header_missing");
      summaryCols = { opening: centre(o), closing: centre(c) };
      continue;
    }
    if (summaryCols && !cols && (text.startsWith("total ") || text.startsWith("cont "))) {
      // Rândul „Total” are prioritate (un singur produs: identic cu rândul contului).
      const amounts = amountItems(row, STYLE, SUFFIX);
      const near = (x: number) =>
        amounts.slice().sort((a, b) => Math.abs(centre(a) - x) - Math.abs(centre(b) - x))[0];
      const o = near(summaryCols.opening);
      const c = near(summaryCols.closing);
      if (!o || !c || o === c) throw new StatementError("corrupt_row");
      if (opening === null || text.startsWith("total ")) {
        opening = amount(o);
        closing = amount(c);
      }
      continue;
    }
    const period = /^tranzactii din cont de la (.+) pana la (.+)$/.exec(text);
    if (period) {
      periodStart = parseRoDate(period[1]!);
      periodEnd = parseRoDate(period[2]!);
      pending = false;
      continue;
    }
    if (/^tranzactii (in asteptare|in curs)/.test(text)) {
      pending = true;
      current = null;
      continue;
    }
    const header = findColumns(row, ["sume retrase"], ["sume adaugate"], ["sold"]);
    if (header && text.startsWith("data ")) {
      cols = header;
      continue;
    }
    if (text.startsWith("revolut bank uab este autorizata") || text.startsWith("© ")) {
      current = null;
      continue;
    }
    if (!cols || !currency) continue;

    const first = row.items[0];
    if (first && first.x < 100 && isRoDate(first.s)) {
      if (pending) {
        pendingCount++;
        continue;
      }
      const desc = row.items[1];
      const moves = amountItems(row, STYLE, SUFFIX).filter((it) => {
        const c = columnOf(it, cols!);
        return c === "debit" || c === "credit";
      });
      const bal = amountItems(row, STYLE, SUFFIX).filter((it) => columnOf(it, cols!) === "balance");
      if (!desc || moves.length !== 1 || bal.length > 1) throw new StatementError("corrupt_row");
      const fx = /^Schimbat (?:în|in|din) ([A-Z]{3})$/.exec(desc.s.trim());
      let fxCurrency: Currency | null = null;
      if (fx) {
        try {
          fxCurrency = currencyFrom(fx[1]!);
        } catch {
          fxCurrency = null;
        }
      }
      current = {
        occurredOn: parseRoDate(first.s),
        direction: columnOf(moves[0]!, cols) === "debit" ? "debit" : "credit",
        amountMinor: amount(moves[0]!),
        parts: [desc.s],
        reference: null,
        kind: fx ? "fx" : "movement",
        fxCurrency,
        fxAmountMinor: null,
        balanceAfterMinor: bal[0] ? amount(bal[0]) : null,
        descX: desc.x,
      };
      drafts.push(current);
      continue;
    }
    if (!current || pending) continue;
    const t = rowText(row);
    // Suma în cealaltă monedă a unui schimb valutar (`10,00€`), sub coloana sumelor.
    const fxm = FX_AMOUNT_RE.exec(t);
    if (current.kind === "fx" && fxm && row.items.length === 1) {
      const sym = currencyFromSymbol(t);
      if (current.fxCurrency && sym === current.fxCurrency) {
        current.fxAmountMinor = parseStatementAmount(`${fxm[1]},${fxm[2]}`, STYLE, sym);
      }
      continue;
    }
    if (!row.items[0] || Math.abs(row.items[0].x - current.descX) > 6) continue;
    const id = /^ID tranzac(?:ț|t)ie:\s*(\S+)$/i.exec(t);
    if (id) current.reference = id[1]!;
    else if (/^Card:/i.test(t)) continue;
    else if (/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(t.replace(/\s/g, ""))) continue;
    else current.parts.push(t);
  }

  if (!currency || opening === null || closing === null || !cols) {
    throw new StatementError("header_missing");
  }
  const { lines, zeroCount } = finalizeLines(drafts);
  const warnings: string[] = [];
  if (zeroCount) warnings.push("zero_amount_skipped");
  if (pendingCount) warnings.push("pending_skipped");
  return {
    bank: "revolut",
    format: "pdf",
    parserVersion: REVOLUT_PARSER_VERSION,
    currency,
    periodStart,
    periodEnd,
    openingBalanceMinor: opening,
    closingBalanceMinor: closing,
    declaredDebitMinor: null,
    declaredCreditMinor: null,
    dayBalances: [],
    lines,
    pendingCount,
    zeroCount,
    ibanLast4: last4,
    warnings,
  };
}
