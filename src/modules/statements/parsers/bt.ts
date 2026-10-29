import type { Currency } from "@/lib/money";

import {
  type Columns,
  amountItems,
  columnOf,
  findColumns,
  hasLabel,
  isContinuation,
  labelValue,
} from "../table";
import { type Row, fold, groupRows, isDmy, parseDmy, rowText } from "../text";
import { type DayBalance, type ParsedStatement, StatementError, type TextItem } from "../types";
import { type Draft, amountOf, currencyFrom, finalizeLines, ibanLast4 } from "./common";

/**
 * Banca Transilvania (PDF, „EXTRAS CONT”). Structura (ADR 0018): extrase zilnice concatenate,
 * fiecare cu `SOLD ANTERIOR`, tranzacții (descriere pe mai multe rânduri, `REF:`), `RULAJ ZI`
 * (cu data zilei), `SOLD FINAL ZI`, `RULAJ TOTAL CONT`, `SOLD FINAL CONT`, apoi `SUME BLOCATE`
 * (tranzacții în așteptare: NU se importă, se numără) și `TOTAL DISPONIBIL`. Antetele se repetă pe
 * fiecare pagină; un extras poate continua pe pagina următoare. Sume `1,234.56`, date
 * `dd/mm/yyyy`. Debit/credit după centrul sumei față de antetele `Debit`/`Credit`.
 */
export const BT_PARSER_VERSION = 1;
const STYLE = "comma_dot" as const;

const SUMMARY_LABELS = [
  "sold anterior",
  "rulaj zi",
  "sold final zi",
  "rulaj total cont",
  "sold final cont",
  "total disponibil",
  "fonduri proprii",
  "credit neutilizat",
  "din care",
];

/** Detaliile unei tranzacții (`REF:` = referința băncii). */
function appendContinuation(current: Draft, row: Row): void {
  const t = rowText(row);
  const ref = /^REF:\s*(\S+)$/i.exec(t);
  if (ref) current.reference = ref[1]!;
  else current.parts.push(t);
}

/** Eticheta de sumar a rândului (fără data din față), dacă există. */
function summaryLabel(row: Row): string | null {
  const text = fold(rowText(row)).replace(/^\d{2}\/\d{2}\/\d{4} /, "");
  return SUMMARY_LABELS.find((l) => text.startsWith(l)) ?? null;
}

export function parseBt(raw: readonly TextItem[]): ParsedStatement {
  const rows = groupRows(raw);
  let currency: Currency | null = null;
  let last4: string | null = null;
  let cols: Columns | null = null;

  const drafts: Draft[] = [];
  let block: Draft[] = []; // tranzacțiile zilei curente, până la `RULAJ ZI`
  let current: Draft | null = null;
  let mode: "none" | "tx" | "pending" = "none";
  let pendingCount = 0;
  let opening: bigint | null = null;
  let closing: bigint | null = null;
  let prevClosing: bigint | null = null;
  let firstDay: string | null = null;
  let lastDay: string | null = null;
  let extractDay: string | null = null;
  const dayBalances: DayBalance[] = [];
  const warnings = new Set<string>();
  const used = new Set<number>();

  const value = (i: number): bigint | null => {
    const it = labelValue(rows, i, STYLE, used);
    return it ? amountOf(it, STYLE, currency ?? "RON") : null;
  };

  for (let i = 0; i < rows.length; i++) {
    if (used.has(i)) continue;
    const row = rows[i]!;
    const text = fold(rowText(row));

    // Rândurile de continuare ale tranzacției deschise (detaliile, controlate de plătitor): niciun
    // marcaj de secțiune sau de antet nu se caută pe ele (revizuirea F7-A: o descriere „SUME
    // BLOCATE” / „RULAJ ZI” / „Sold final …” nu schimbă modul, perioada sau soldurile).
    if (mode === "tx" && current && isContinuation(row, current.descX, STYLE)) {
      appendContinuation(current, row);
      continue;
    }

    // Antetul extrasului: `EXTRAS CONT | Numarul: N | din dd/mm/yyyy`.
    if (text.startsWith("extras cont")) {
      const d = row.items
        .map((it) => /^din (\d{2}\/\d{2}\/\d{4})$/.exec(it.s.trim())?.[1])
        .find(Boolean);
      if (!d) throw new StatementError("header_missing");
      extractDay = parseDmy(d, "/");
      continue;
    }
    // `RON | Cod IBAN: RO…` (moneda contului și IBAN-ul din antet).
    const ibanItem = row.items.find((it) => fold(it.s).startsWith("cod iban:"));
    if (ibanItem) {
      const cur = row.items.find((it) => /^[A-Z]{3}$/.test(it.s.trim()));
      if (!cur) throw new StatementError("header_missing");
      const c = currencyFrom(cur.s);
      if (currency && currency !== c) throw new StatementError("currency_mismatch");
      currency = c;
      last4 = ibanLast4(ibanItem.s.replace(/^cod iban:\s*/i, ""));
      continue;
    }
    const header = findColumns(row, ["debit"], ["credit"]);
    if (header && hasLabel(row, "descriere")) {
      cols = header;
      continue;
    }

    const label = summaryLabel(row);
    if (label === "sold anterior") {
      if (!cols || !currency || !extractDay) throw new StatementError("header_missing");
      // Un extras nou cu rânduri neînchise de `RULAJ ZI` = pagină lipsă.
      if (block.length) throw new StatementError("corrupt_row");
      const v = value(i);
      if (v === null) throw new StatementError("corrupt_row");
      if (opening === null) opening = v;
      else if (prevClosing !== null && v !== prevClosing) warnings.add("balance_chain_break");
      mode = "tx";
      current = null;
      continue;
    }
    if (label === "rulaj zi") {
      const d = row.items.find((it) => isDmy(it.s, "/"));
      const day = d ? parseDmy(d.s, "/") : extractDay;
      if (!day) throw new StatementError("corrupt_row");
      for (const b of block) b.occurredOn = day;
      drafts.push(...block);
      block = [];
      current = null;
      firstDay ??= day;
      lastDay = day;
      continue;
    }
    if (label === "sold final zi") {
      const v = value(i);
      if (v !== null && lastDay) dayBalances.push({ day: lastDay, closingMinor: v });
      current = null;
      continue;
    }
    if (label === "sold final cont") {
      const v = value(i);
      if (v !== null) {
        closing = v;
        prevClosing = v;
      }
      if (block.length) throw new StatementError("corrupt_row");
      mode = "none";
      current = null;
      continue;
    }
    if (label === "rulaj total cont" || label === "din care" || label === "fonduri proprii") {
      current = null;
      continue;
    }
    if (label === "total disponibil" || label === "credit neutilizat") {
      if (label === "total disponibil") value(i);
      mode = "none";
      current = null;
      continue;
    }
    if (text.startsWith("sume blocate")) {
      mode = "pending";
      current = null;
      continue;
    }

    if (mode === "pending") {
      // `- | 31.00 RON | aferenta tranzactiei | …` = o tranzacție în așteptare.
      // pdf.js poate uni „-” cu suma într-un singur fragment: se citește textul rândului.
      if (/^- ?\d[\d.,]* (RON|EUR|USD)\b/.test(rowText(row).trim())) pendingCount++;
      continue;
    }
    if (mode !== "tx" || !cols || !currency) continue;

    const amounts = amountItems(row, STYLE).filter((it) => {
      const c = columnOf(it, cols!);
      return c === "debit" || c === "credit";
    });
    const desc = row.items.find(
      (it) => it.x > 50 && !amountItems({ ...row, items: [it] }, STYLE).length,
    );
    if (amounts.length === 1 && desc) {
      const direction = columnOf(amounts[0]!, cols) === "debit" ? "debit" : "credit";
      current = {
        occurredOn: null,
        direction,
        amountMinor: amountOf(amounts[0]!, STYLE, currency),
        parts: [desc.s],
        reference: null,
        kind: "movement",
        fxCurrency: null,
        fxAmountMinor: null,
        balanceAfterMinor: null,
        descX: desc.x,
      };
      block.push(current);
      continue;
    }
    // Două sume pe un rând cu descriere = rând corupt; fără descriere = valorile unui rulaj.
    if (amounts.length > 1 && desc) throw new StatementError("corrupt_row");
  }

  if (block.length) throw new StatementError("corrupt_row");
  if (!currency || opening === null || closing === null) throw new StatementError("header_missing");
  const { lines, zeroCount } = finalizeLines(drafts);
  if (zeroCount) warnings.add("zero_amount_skipped");
  if (pendingCount) warnings.add("pending_skipped");
  return {
    bank: "bt",
    format: "pdf",
    parserVersion: BT_PARSER_VERSION,
    currency,
    periodStart: firstDay ?? extractDay,
    periodEnd: lastDay ?? extractDay,
    openingBalanceMinor: opening,
    closingBalanceMinor: closing,
    declaredDebitMinor: null,
    declaredCreditMinor: null,
    dayBalances,
    lines,
    pendingCount,
    zeroCount,
    ibanLast4: last4,
    warnings: [...warnings],
  };
}
