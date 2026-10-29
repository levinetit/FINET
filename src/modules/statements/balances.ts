import type { ParsedStatement } from "./types";

/**
 * Verificarea soldurilor ÎN COD (master prompt 3.6, Faza 7): sold inițial + Σ mișcări = sold
 * final, pe extras, pe zi (unde extrasul declară soldul zilei), pe rând (unde extrasul arată
 * soldul după fiecare rând) și față de totalurile declarate. La orice nepotrivire importul rămâne
 * „De verificat” (`mismatch`) cu motivele (coduri fixe); nu se salvează tăcut.
 */

export type BalanceReason =
  "closing_balance" | "day_balance" | "row_balance" | "declared_totals" | "balance_chain_break";

export type BalanceCheck = Readonly<{
  status: "ok" | "mismatch" | "unknown";
  computedClosingMinor: bigint | null;
  reasons: readonly BalanceReason[];
  debitTotalMinor: bigint;
  creditTotalMinor: bigint;
}>;

export function checkBalances(s: ParsedStatement): BalanceCheck {
  const reasons = new Set<BalanceReason>();
  let debit = 0n;
  let credit = 0n;
  let running = s.openingBalanceMinor;
  const endOfDay = new Map<string, bigint>();
  for (const line of s.lines) {
    if (line.direction === "debit") debit += line.amountMinor;
    else credit += line.amountMinor;
    if (running !== null) {
      running += line.direction === "credit" ? line.amountMinor : -line.amountMinor;
      endOfDay.set(line.occurredOn, running);
      if (line.balanceAfterMinor !== null && line.balanceAfterMinor !== running) {
        reasons.add("row_balance");
      }
    }
  }
  const computed = running;
  if (computed !== null && s.closingBalanceMinor !== null && computed !== s.closingBalanceMinor) {
    reasons.add("closing_balance");
  }
  for (const d of s.dayBalances) {
    const got = endOfDay.get(d.day);
    if (got !== undefined && got !== d.closingMinor) reasons.add("day_balance");
  }
  if (s.declaredDebitMinor !== null && s.declaredDebitMinor !== debit)
    reasons.add("declared_totals");
  if (s.declaredCreditMinor !== null && s.declaredCreditMinor !== credit) {
    reasons.add("declared_totals");
  }
  if (s.warnings.includes("balance_chain_break")) reasons.add("balance_chain_break");
  const known = s.openingBalanceMinor !== null && s.closingBalanceMinor !== null;
  return {
    status: reasons.size > 0 ? "mismatch" : known ? "ok" : "unknown",
    computedClosingMinor: computed,
    reasons: [...reasons],
    debitTotalMinor: debit,
    creditTotalMinor: credit,
  };
}
