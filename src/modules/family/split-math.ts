import { type Currency, allocate, money } from "@/lib/money";

/**
 * Aritmetica familiei (Faza 8, ADR 0016), pură și deterministă, doar `bigint` (5.1): împărțirea
 * unei cheltuieli în părți și soldurile reciproce. Fără bază de date, ca să fie testată exhaustiv.
 *
 * Reguli de rotunjire (documentate în ADR 0016):
 * - participanții se sortează întâi după `userId` (ordinea din cerere nu contează);
 * - EGAL: fiecare primește ⌊total / n⌋, iar cele `total mod n` unități minore rămase se dau câte
 *   una primilor participanți în ordinea `userId`;
 * - PROCENTE: în puncte de bază (1% = 100), întregi, cu suma EXACT 10000; partea întreagă din
 *   total × pb / 10000, iar unitățile rămase merg la resturile cele mai mari (metoda restului cel
 *   mai mare, `allocate` din money.ts), la egalitate primului în ordinea `userId`;
 * - SUME FIXE: date de utilizator, suma lor trebuie să fie exact totalul (altfel eroare).
 * În toate modurile suma părților = totalul, exact.
 */

export type ShareInput = Readonly<{ userId: string; value: bigint }>;
export type Share = Readonly<{ userId: string; shareMinor: bigint }>;

export const BASIS_POINTS_TOTAL = 10_000n;

/** Eroare de împărțire (cod stabil, fără valori). */
export class SplitMathError extends Error {
  constructor(
    readonly reason:
      "no_participants" | "duplicate_participant" | "percent_total" | "fixed_total" | "negative",
  ) {
    super(`împărțire invalidă: ${reason}`);
    this.name = "SplitMathError";
  }
}

function byUser<T extends { userId: string }>(list: readonly T[]): T[] {
  const sorted = [...list].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.userId === sorted[i - 1]!.userId) {
      throw new SplitMathError("duplicate_participant");
    }
  }
  return sorted;
}

function checkTotal(total: bigint): void {
  if (total < 0n) throw new SplitMathError("negative");
}

/** Împărțire egală între `userIds`. */
export function splitEqually(
  total: bigint,
  currency: Currency,
  userIds: readonly string[],
): Share[] {
  checkTotal(total);
  if (userIds.length === 0) throw new SplitMathError("no_participants");
  const users = byUser(userIds.map((userId) => ({ userId })));
  const parts = allocate(
    money(total, currency),
    users.map(() => 1n),
  );
  return users.map((u, i) => ({ userId: u.userId, shareMinor: parts[i]!.amountMinor }));
}

/** Împărțire pe procente, în puncte de bază (suma exact 10000). */
export function splitByBasisPoints(
  total: bigint,
  currency: Currency,
  shares: readonly ShareInput[],
): Share[] {
  checkTotal(total);
  if (shares.length === 0) throw new SplitMathError("no_participants");
  const sorted = byUser(shares);
  let sum = 0n;
  for (const s of sorted) {
    if (s.value < 0n) throw new SplitMathError("negative");
    sum += s.value;
  }
  if (sum !== BASIS_POINTS_TOTAL) throw new SplitMathError("percent_total");
  const parts = allocate(
    money(total, currency),
    sorted.map((s) => s.value),
  );
  return sorted.map((s, i) => ({ userId: s.userId, shareMinor: parts[i]!.amountMinor }));
}

/** Sume fixe: suma lor trebuie să fie exact totalul. */
export function splitFixed(total: bigint, shares: readonly ShareInput[]): Share[] {
  checkTotal(total);
  if (shares.length === 0) throw new SplitMathError("no_participants");
  const sorted = byUser(shares);
  let sum = 0n;
  for (const s of sorted) {
    if (s.value < 0n) throw new SplitMathError("negative");
    sum += s.value;
  }
  if (sum !== total) throw new SplitMathError("fixed_total");
  return sorted.map((s) => ({ userId: s.userId, shareMinor: s.value }));
}

// ---------------------------------------------------------------------------------------------
// Solduri reciproce
// ---------------------------------------------------------------------------------------------

export type SplitRow = Readonly<{
  payerUserId: string;
  userId: string;
  shareMinor: bigint;
  currency: Currency;
}>;

export type SettlementRow = Readonly<{
  fromUserId: string;
  toUserId: string;
  amountMinor: bigint;
  currency: Currency;
}>;

/** `debtorUserId` îi datorează lui `creditorUserId` suma (strict pozitivă). */
export type PairBalance = Readonly<{
  debtorUserId: string;
  creditorUserId: string;
  amountMinor: bigint;
}>;

/** Pozitiv = are de primit; negativ = are de dat. */
export type MemberNet = Readonly<{ userId: string; netMinor: bigint }>;

export type CurrencyBalances = Readonly<{
  currency: Currency;
  pairs: PairBalance[];
  members: MemberNet[];
}>;

/**
 * Soldurile pe monedă (fără conversie): pentru fiecare pereche, netting-ul tuturor părților
 * (participantul îi datorează plătitorului partea lui; partea plătitorului nu creează datorie)
 * și al decontărilor (`from` i-a dat lui `to`: datoria lui `from` față de `to` scade). Totalul pe
 * membru = suma perechilor lui; suma totalurilor e 0. Ordinea e deterministă (monedă, apoi
 * `userId`). Perechile cu sold 0 nu apar; membrii cu sold 0 apar doar dacă au avut mișcări.
 */
export function computeBalances(
  splits: readonly SplitRow[],
  settlements: readonly SettlementRow[],
): CurrencyBalances[] {
  // currency → "x|y" (x < y) → cât îi datorează x lui y (cu semn).
  const ledger = new Map<Currency, Map<string, bigint>>();
  const seen = new Map<Currency, Set<string>>();
  const owe = (currency: Currency, debtor: string, creditor: string, amount: bigint) => {
    if (debtor === creditor || amount === 0n) return;
    let pairs = ledger.get(currency);
    if (!pairs) ledger.set(currency, (pairs = new Map()));
    let users = seen.get(currency);
    if (!users) seen.set(currency, (users = new Set()));
    users.add(debtor);
    users.add(creditor);
    const [x, y, sign] = debtor < creditor ? [debtor, creditor, 1n] : [creditor, debtor, -1n];
    const key = `${x}|${y}`;
    pairs.set(key, (pairs.get(key) ?? 0n) + sign * amount);
  };
  for (const s of splits) owe(s.currency, s.userId, s.payerUserId, s.shareMinor);
  for (const s of settlements) owe(s.currency, s.toUserId, s.fromUserId, s.amountMinor);

  const out: CurrencyBalances[] = [];
  for (const currency of [...ledger.keys()].sort()) {
    const pairs: PairBalance[] = [];
    const net = new Map<string, bigint>();
    for (const u of seen.get(currency) ?? []) net.set(u, 0n);
    for (const [key, amount] of [...ledger.get(currency)!.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      if (amount === 0n) continue;
      const [x, y] = key.split("|") as [string, string];
      const [debtor, creditor, value] = amount > 0n ? [x, y, amount] : [y, x, -amount];
      pairs.push({ debtorUserId: debtor, creditorUserId: creditor, amountMinor: value });
      net.set(debtor, net.get(debtor)! - value);
      net.set(creditor, net.get(creditor)! + value);
    }
    const members = [...net.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([userId, netMinor]) => ({ userId, netMinor }));
    out.push({ currency, pairs, members });
  }
  return out;
}

/** `true` dacă utilizatorul nu are nicio pereche cu sold nenul, în nicio monedă. */
export function isSettled(balances: readonly CurrencyBalances[], userId: string): boolean {
  return balances.every((c) =>
    c.pairs.every((p) => p.debtorUserId !== userId && p.creditorUserId !== userId),
  );
}
