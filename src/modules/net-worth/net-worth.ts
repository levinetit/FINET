import { type AccountType, VALUED_ACCOUNT_TYPES } from "@/db/schema";
import type { CalendarDate, Month } from "@/lib/calendar";
import type { Currency } from "@/lib/money";

/**
 * Averea netă (modernizare 2026, pasul G; ADR 0046): funcții PURE, în `bigint`.
 *
 * Valoarea unui cont la o dată:
 * - conturile tranzacționale (cash, bancă, economii, card de credit): soldul = sold inițial +
 *   netul tranzacțiilor de până la data respectivă (soldul inițial e „fără dată”, ca în restul
 *   aplicației);
 * - conturile evaluate (investiții, proprietăți, vehicule, credite, altele): evaluarea cea mai
 *   recentă de până la acea dată; fără nicio evaluare, soldul ca mai sus (soldul inițial e atunci
 *   valoarea de pornire).
 * Semnul e al soldului: activele pozitive, pasivele negative. Averea netă = Σ valori; activele =
 * Σ valorilor pozitive, pasivele = Σ valorilor negative (în modul), oricare ar fi tipul contului
 * (un card de credit cu sold pozitiv e un activ; un cont „activ” cu sold negativ, un pasiv).
 * Istoricul = aceeași formulă la sfârșitul fiecărei luni (fără instantanee stocate).
 */

export type AccountKind = "asset" | "liability";

/** Tipul contului → clasa „așteptată” (pentru grupare și etichete), nu semnul valorii. */
export const ACCOUNT_KIND: Readonly<Record<AccountType, AccountKind>> = Object.freeze({
  cash: "asset",
  bank: "asset",
  savings: "asset",
  investment: "asset",
  property: "asset",
  vehicle: "asset",
  other_asset: "asset",
  credit_card: "liability",
  loan: "liability",
  other_liability: "liability",
});

const VALUED = new Set<string>(VALUED_ACCOUNT_TYPES);
export const isValuedType = (type: AccountType): boolean => VALUED.has(type);

export type NetWorthAccount = Readonly<{
  id: string;
  name: string;
  type: AccountType;
  currency: Currency;
  openingBalanceMinor: bigint;
  archivedAt: Date | null;
}>;

export type Valuation = Readonly<{ accountId: string; valuedOn: CalendarDate; valueMinor: bigint }>;

/** Netul tranzacțiilor unui cont într-o lună (venit + intrări − cheltuieli − ieșiri). */
export type AccountMonthNet = Readonly<{ accountId: string; month: Month; netMinor: bigint }>;

export type AccountValue = Readonly<{
  accountId: string;
  name: string;
  type: AccountType;
  kind: AccountKind;
  valueMinor: bigint;
  basis: "balance" | "valuation";
  /** Data evaluării folosite (doar `basis = valuation`). */
  valuedOn: CalendarDate | null;
  archived: boolean;
}>;

export type NetWorthPoint = Readonly<{
  asOf: CalendarDate;
  assetsMinor: bigint;
  liabilitiesMinor: bigint;
  netMinor: bigint;
}>;

export type TypeBreakdown = Readonly<{
  type: AccountType;
  kind: AccountKind;
  valueMinor: bigint;
  accounts: readonly AccountValue[];
}>;

export type NetWorth = Readonly<{
  currency: Currency;
  asOf: CalendarDate;
  current: NetWorthPoint;
  byType: readonly TypeBreakdown[];
  /** Punctele lunare (sfârșitul fiecărei luni, cronologic), ultimul = `asOf`. */
  history: readonly NetWorthPoint[];
}>;

/** Soldul contului la sfârșitul datei: sold inițial + netul lunilor ≤ luna datei. */
export function balanceAt(
  account: NetWorthAccount,
  nets: readonly AccountMonthNet[],
  asOf: CalendarDate,
): bigint {
  const month = asOf.slice(0, 7);
  let balance = account.openingBalanceMinor;
  for (const n of nets) {
    if (n.accountId === account.id && n.month <= month) balance += n.netMinor;
  }
  return balance;
}

/** Evaluarea cea mai recentă cu `valuedOn ≤ asOf`, sau `null`. */
export function latestValuation(
  accountId: string,
  valuations: readonly Valuation[],
  asOf: CalendarDate,
): Valuation | null {
  let best: Valuation | null = null;
  for (const v of valuations) {
    if (v.accountId !== accountId || v.valuedOn > asOf) continue;
    if (best === null || v.valuedOn > best.valuedOn) best = v;
  }
  return best;
}

export function accountValueAt(
  account: NetWorthAccount,
  valuations: readonly Valuation[],
  nets: readonly AccountMonthNet[],
  asOf: CalendarDate,
): AccountValue {
  const base = {
    accountId: account.id,
    name: account.name,
    type: account.type,
    kind: ACCOUNT_KIND[account.type],
    archived: account.archivedAt !== null,
  };
  if (isValuedType(account.type)) {
    const v = latestValuation(account.id, valuations, asOf);
    if (v) return { ...base, valueMinor: v.valueMinor, basis: "valuation", valuedOn: v.valuedOn };
  }
  return { ...base, valueMinor: balanceAt(account, nets, asOf), basis: "balance", valuedOn: null };
}

export function pointOf(values: readonly AccountValue[], asOf: CalendarDate): NetWorthPoint {
  let assets = 0n;
  let liabilities = 0n;
  for (const v of values) {
    if (v.valueMinor >= 0n) assets += v.valueMinor;
    else liabilities += -v.valueMinor;
  }
  return {
    asOf,
    assetsMinor: assets,
    liabilitiesMinor: liabilities,
    netMinor: assets - liabilities,
  };
}

/** Gruparea pe tip, în ordinea activelor apoi a pasivelor, fără tipurile fără conturi. */
export function breakdownOf(values: readonly AccountValue[]): TypeBreakdown[] {
  const order: AccountType[] = [
    "cash",
    "bank",
    "savings",
    "investment",
    "property",
    "vehicle",
    "other_asset",
    "credit_card",
    "loan",
    "other_liability",
  ];
  return order
    .map((type) => {
      const accounts = values
        .filter((v) => v.type === type)
        .sort(
          (a, b) => a.name.localeCompare(b.name, "ro") || a.accountId.localeCompare(b.accountId),
        );
      return {
        type,
        kind: ACCOUNT_KIND[type],
        valueMinor: accounts.reduce((acc, v) => acc + v.valueMinor, 0n),
        accounts,
      };
    })
    .filter((b) => b.accounts.length > 0);
}

export type NetWorthInputs = Readonly<{
  currency: Currency;
  asOf: CalendarDate;
  /** Sfârșiturile de lună ale istoricului, cronologic (ultimul poate fi > `asOf`; se înlocuiește cu `asOf`). */
  monthEnds: readonly CalendarDate[];
  accounts: readonly NetWorthAccount[];
  valuations: readonly Valuation[];
  nets: readonly AccountMonthNet[];
}>;

export function computeNetWorth(input: NetWorthInputs): NetWorth {
  const valuesNow = input.accounts.map((a) =>
    accountValueAt(a, input.valuations, input.nets, input.asOf),
  );
  const history = input.monthEnds.map((end) => {
    const at = end > input.asOf ? input.asOf : end;
    return pointOf(
      input.accounts.map((a) => accountValueAt(a, input.valuations, input.nets, at)),
      at,
    );
  });
  return {
    currency: input.currency,
    asOf: input.asOf,
    current: pointOf(valuesNow, input.asOf),
    byType: breakdownOf(valuesNow),
    history,
  };
}
