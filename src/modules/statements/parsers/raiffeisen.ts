import type { Currency } from "@/lib/money";

import { type Columns, amountItems, columnOf, findColumns, isContinuation } from "../table";
import {
  type Row,
  centre,
  fold,
  groupRows,
  isAmount,
  isDmy,
  parseDmy,
  parseStatementAmount,
  repairRaiffeisen,
  rowText,
} from "../text";
import { type DayBalance, type ParsedStatement, StatementError, type TextItem } from "../types";
import { type Draft, amountOf, currencyFrom, finalizeLines, ibanLast4 } from "./common";

/**
 * Raiffeisen Bank (PDF). Fontul extrasului are encodare defectuoasă: diacriticele apar ca
 * simboluri (`Dat\`` = Dată, `ini]ial` = inițial); textul se repară (`repairRaiffeisen`) DUPĂ
 * detectarea băncii. Antet: `Perioada: de la dd.mm.yyyy la dd.mm.yyyy`, `Cod IBAN:`, `Valuta:`,
 * sumar `Sold inițial | Rulaj debitor | Rulaj creditor | Sold final` (valorile pe rândul de sub
 * etichete); tabel `Dată înregistrare | Data tranzacției | Descrierea tranzacției | Sumă debit |
 * Sumă credit`; `Soldul zilei: dd.mm.yyyy N`; `Sold final N`. Sume `4,321.00`.
 * Data importată = data ÎNREGISTRĂRII (cea la care se schimbă soldul zilei; decizia mea).
 * `Schimb valutar RON/EUR` = schimb valutar (suma în cealaltă monedă nu apare: o cere confirmarea).
 */
export const RAIFFEISEN_PARSER_VERSION = 1;
const STYLE = "comma_dot" as const;

/** Valorile sumarului: rândul de sub etichete, fiecare valoare la eticheta cu centrul cel mai apropiat. */
function summaryValues(labels: Row, values: Row | undefined, currency: Currency) {
  const names = ["sold initial", "rulaj debitor", "rulaj creditor", "sold final"] as const;
  const centres = names.map((n) => {
    const it = labels.items.find((i) => fold(i.s) === n);
    if (!it) throw new StatementError("header_missing");
    return centre(it);
  });
  const out: Record<(typeof names)[number], bigint | null> = {
    "sold initial": null,
    "rulaj debitor": null,
    "rulaj creditor": null,
    "sold final": null,
  };
  for (const it of values?.items ?? []) {
    if (!isAmount(it.s, STYLE)) throw new StatementError("corrupt_row");
    const k = centres
      .map((c, idx) => [idx, Math.abs(c - centre(it))] as const)
      .sort((a, b) => a[1] - b[1])[0]![0];
    out[names[k]!] = amountOf(it, STYLE, currency);
  }
  return out;
}

export function parseRaiffeisen(raw: readonly TextItem[]): ParsedStatement {
  const rows = groupRows(raw.map((i) => ({ ...i, s: repairRaiffeisen(i.s) })));
  let currency: Currency | null = null;
  let last4: string | null = null;
  let cols: Columns | null = null;
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  let summary: ReturnType<typeof summaryValues> | null = null;
  let closing: bigint | null = null;
  const dayBalances: DayBalance[] = [];
  const drafts: Draft[] = [];
  let current: Draft | null = null;
  let ended = false;

  for (let i = 0; i < rows.length && !ended; i++) {
    const row = rows[i]!;
    const text = fold(rowText(row));

    // Rândurile de continuare ale tranzacției deschise (detaliile, controlate de plătitor): niciun
    // marcaj de secțiune sau de antet nu se caută pe ele (revizuirea F7-A: o descriere „SUME
    // BLOCATE” / „RULAJ ZI” / „Sold final …” nu schimbă modul, perioada sau soldurile).
    if (current && isContinuation(row, current.descX, STYLE)) {
      current.parts.push(rowText(row));
      continue;
    }

    const period = /^perioada: de la (\d{2}\.\d{2}\.\d{4}) la (\d{2}\.\d{2}\.\d{4})$/.exec(text);
    if (period && periodStart === null) {
      periodStart = parseDmy(period[1]!, ".");
      periodEnd = parseDmy(period[2]!, ".");
      continue;
    }
    const ibanIdx = row.items.findIndex((it) => fold(it.s) === "cod iban:");
    if (ibanIdx >= 0 && !summary) {
      last4 = ibanLast4(row.items[ibanIdx + 1]?.s);
    }
    const curIdx = row.items.findIndex((it) => fold(it.s) === "valuta:");
    if (curIdx >= 0) {
      const c = currencyFrom(row.items[curIdx + 1]?.s ?? "");
      if (currency && currency !== c) throw new StatementError("currency_mismatch");
      currency = c;
      continue;
    }
    if (row.items.some((it) => fold(it.s) === "rulaj debitor")) {
      if (!currency) throw new StatementError("header_missing");
      summary = summaryValues(row, rows[i + 1], currency);
      i++;
      continue;
    }
    const header = findColumns(row, ["suma debit"], ["suma credit"]);
    if (header) {
      cols = header;
      continue;
    }
    if (text.startsWith("prezentul extras are valoare")) {
      current = null; // subsolul: continuarea reia după antetul paginii următoare
      continue;
    }
    if (!cols || !currency || !summary) continue;

    // `Soldul zilei: dd.mm.yyyy N` și `Sold final N` (câte un singur fragment).
    let isBalanceRow = false;
    for (const it of row.items) {
      const day = /^Soldul zilei: (\d{2}\.\d{2}\.\d{4}) (\S+)$/.exec(it.s.trim());
      if (day) {
        dayBalances.push({
          day: parseDmy(day[1]!, "."),
          closingMinor: parseStatementAmount(day[2]!, STYLE, currency),
        });
        isBalanceRow = true;
      }
      const fin = /^Sold final (\S+)$/.exec(it.s.trim());
      if (fin) {
        closing = parseStatementAmount(fin[1]!, STYLE, currency);
        ended = true;
        isBalanceRow = true;
      }
    }
    if (isBalanceRow) {
      current = null;
      continue;
    }

    const [d1, d2, desc] = row.items;
    const amounts = amountItems(row, STYLE).filter((it) => {
      const c = columnOf(it, cols!);
      return c === "debit" || c === "credit";
    });
    if (d1 && d1.x < 50 && isDmy(d1.s, ".")) {
      if (!d2 || !isDmy(d2.s, ".") || !desc || amounts.length !== 1) {
        throw new StatementError("corrupt_row");
      }
      const fx = /^Schimb valutar ([A-Z]{3})\/([A-Z]{3})/.exec(desc.s.trim());
      let fxCurrency: Currency | null = null;
      if (fx) {
        const other = fx[1] === currency ? fx[2]! : fx[1]!;
        try {
          fxCurrency = currencyFrom(other);
        } catch {
          fxCurrency = null;
        }
      }
      current = {
        occurredOn: parseDmy(d1.s, "."),
        direction: columnOf(amounts[0]!, cols) === "debit" ? "debit" : "credit",
        amountMinor: amountOf(amounts[0]!, STYLE, currency),
        parts: [desc.s],
        reference: null,
        kind: fx ? "fx" : "movement",
        fxCurrency,
        fxAmountMinor: null,
        balanceAfterMinor: null,
        descX: desc.x,
      };
      drafts.push(current);
      continue;
    }
    if (amounts.length > 0) throw new StatementError("corrupt_row");
    if (current && isContinuation(row, current.descX, STYLE)) current.parts.push(rowText(row));
  }

  if (!currency || !summary || summary["sold initial"] === null) {
    throw new StatementError("header_missing");
  }
  const declaredClosing = summary["sold final"];
  if (closing === null) closing = declaredClosing;
  if (closing === null) throw new StatementError("header_missing");
  const warnings: string[] = [];
  if (declaredClosing !== null && declaredClosing !== closing) warnings.push("balance_chain_break");
  const { lines, zeroCount } = finalizeLines(drafts);
  if (zeroCount) warnings.push("zero_amount_skipped");
  return {
    bank: "raiffeisen",
    format: "pdf",
    parserVersion: RAIFFEISEN_PARSER_VERSION,
    currency,
    periodStart,
    periodEnd,
    openingBalanceMinor: summary["sold initial"],
    closingBalanceMinor: closing,
    declaredDebitMinor: summary["rulaj debitor"],
    declaredCreditMinor: summary["rulaj creditor"],
    dayBalances,
    lines,
    pendingCount: 0,
    zeroCount,
    ibanLast4: last4,
    warnings,
  };
}
