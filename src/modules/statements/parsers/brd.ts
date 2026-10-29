import type { Currency } from "@/lib/money";

import {
  type Columns,
  amountItems,
  columnOf,
  findColumns,
  isContinuation,
  labelValue,
} from "../table";
import { fold, groupRows, isDmy, parseDmy, rowText } from "../text";
import { type ParsedStatement, StatementError, type TextItem } from "../types";
import { type Draft, amountOf, currencyFrom, finalizeLines, ibanLast4 } from "./common";

/**
 * BRD (PDF bilingv RO/EN, „Extras de cont / Statement”). Antet cu `De la / From … La / To …`,
 * `IBAN`, `Valuta / Currency`; tabel `Data oper. | Descriere operatiune | Debit | Credit |
 * Data val.`; `Sold initial / Start balance`, rânduri cu descriere pe mai multe linii (care pot
 * continua pe pagina următoare), `Total debit / Total credit`, `Sold final / End balance`.
 * Sume `1.234,56`, date `dd/mm/yyyy`. Data tranzacției = `Data oper.` (decizia mea, ADR 0018).
 */
export const BRD_PARSER_VERSION = 1;
const STYLE = "dot_comma" as const;

// Codurile operațiunii (`OP…`, `NC …`, `OP …/…`) = referința băncii (nu e unică).
const REFERENCE_RE = /^(?:OP[A-Z0-9/]{6,}|NC \d[\d ]{6,}|OP \d+\/\d+)$/;

export function parseBrd(raw: readonly TextItem[]): ParsedStatement {
  const rows = groupRows(raw);
  let currency: Currency | null = null;
  let last4: string | null = null;
  let cols: Columns | null = null;
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  let opening: bigint | null = null;
  let closing: bigint | null = null;
  let declaredDebit: bigint | null = null;
  let declaredCredit: bigint | null = null;
  const drafts: Draft[] = [];
  let current: Draft | null = null;
  let ended = false;
  const used = new Set<number>();

  for (let i = 0; i < rows.length && !ended; i++) {
    if (used.has(i)) continue;
    const row = rows[i]!;
    const text = fold(rowText(row));

    if (text.includes("de la / from") && periodStart === null) {
      const dates = row.items.filter((it) => isDmy(it.s, "/"));
      if (dates.length !== 2) throw new StatementError("header_missing");
      periodStart = parseDmy(dates[0]!.s, "/");
      periodEnd = parseDmy(dates[1]!.s, "/");
      continue;
    }
    if (text.startsWith("iban ")) {
      last4 = ibanLast4(row.items[1]?.s);
      continue;
    }
    if (text.startsWith("valuta / currency")) {
      const cur = row.items[row.items.length - 1];
      currency = currencyFrom(cur?.s ?? "");
      continue;
    }
    const header = findColumns(row, ["debit"], ["credit"]);
    if (header && text.startsWith("data oper")) {
      cols = header;
      current = current ?? null;
      continue;
    }
    if (text.startsWith("trans.date") || text.startsWith("pag. ")) continue;
    if (text.includes("brd-groupe societe generale")) {
      continue; // subsolul paginii (continuarea descrierii reia după antetul paginii următoare)
    }
    if (text.startsWith("sold initial / start balance")) {
      if (!currency || !cols) throw new StatementError("header_missing");
      const v = labelValue(rows, i, STYLE, used);
      if (!v) throw new StatementError("corrupt_row");
      opening = amountOf(v, STYLE, currency);
      continue;
    }
    if (text.startsWith("total debit / total credit")) {
      if (!currency || !cols) throw new StatementError("header_missing");
      for (const it of amountItems(row, STYLE)) {
        const c = columnOf(it, cols);
        if (c === "debit") declaredDebit = amountOf(it, STYLE, currency);
        if (c === "credit") declaredCredit = amountOf(it, STYLE, currency);
      }
      current = null;
      continue;
    }
    if (text.startsWith("sold final / end balance")) {
      if (!currency) throw new StatementError("header_missing");
      const v = labelValue(rows, i, STYLE, used);
      if (!v) throw new StatementError("corrupt_row");
      closing = amountOf(v, STYLE, currency);
      ended = true;
      continue;
    }
    if (opening === null || !cols || !currency) continue;

    const first = row.items[0];
    const amounts = amountItems(row, STYLE).filter((it) => {
      const c = columnOf(it, cols!);
      return c === "debit" || c === "credit";
    });
    if (first && first.x < 60 && isDmy(first.s, "/")) {
      const desc = row.items[1];
      if (amounts.length !== 1 || !desc || isDmy(desc.s, "/")) {
        throw new StatementError("corrupt_row");
      }
      current = {
        occurredOn: parseDmy(first.s, "/"),
        direction: columnOf(amounts[0]!, cols) === "debit" ? "debit" : "credit",
        amountMinor: amountOf(amounts[0]!, STYLE, currency),
        parts: [desc.s],
        reference: null,
        kind: "movement",
        fxCurrency: null,
        fxAmountMinor: null,
        balanceAfterMinor: null,
        descX: desc.x,
      };
      drafts.push(current);
      continue;
    }
    if (amounts.length > 0) throw new StatementError("corrupt_row");
    if (current && isContinuation(row, current.descX, STYLE)) {
      const t = rowText(row);
      if (current.reference === null && REFERENCE_RE.test(t)) current.reference = t;
      else current.parts.push(t);
    }
  }

  if (!currency || opening === null || closing === null) throw new StatementError("header_missing");
  const { lines, zeroCount } = finalizeLines(drafts);
  return {
    bank: "brd",
    format: "pdf",
    parserVersion: BRD_PARSER_VERSION,
    currency,
    periodStart,
    periodEnd,
    openingBalanceMinor: opening,
    closingBalanceMinor: closing,
    declaredDebitMinor: declaredDebit,
    declaredCreditMinor: declaredCredit,
    dayBalances: [],
    lines,
    pendingCount: 0,
    zeroCount,
    ibanLast4: last4,
    warnings: zeroCount ? ["zero_amount_skipped"] : [],
  };
}
