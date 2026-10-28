import { z } from "zod";

import { ACCOUNT_TYPES, DB_CURRENCIES } from "@/db/schema";
import { type Currency, type MoneyJson, money, toJson } from "@/lib/money";
import {
  amountTextSchema,
  idSchema,
  notBoth,
  requiredName,
  signedMinorSchema,
} from "@/modules/ledger/input";

/** Conturile (master prompt 6.1, 5.6). Zod strict: `householdId` și alte chei sunt respinse. */

export const ACCOUNT_NAME_MAX = 100;

const bankCodeSchema = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .refine((v) => /^[a-z0-9_]{2,32}$/.test(v), { message: "Cod de bancă invalid." })
  .nullable()
  .optional();

export const accountCreateSchema = z
  .strictObject({
    name: requiredName(ACCOUNT_NAME_MAX),
    type: z.enum(ACCOUNT_TYPES),
    currency: z.enum(DB_CURRENCIES),
    // Soldul inițial: întreg în unități minore SAU text (`-1.234,50`); implicit 0.
    openingBalanceMinor: signedMinorSchema.optional(),
    openingBalance: amountTextSchema.optional(),
    bankCode: bankCodeSchema,
    // Contul personal al unui membru; `null`/lipsă = cont comun.
    ownerUserId: idSchema.nullable().optional(),
  })
  .refine((v) => notBoth({ amountMinor: v.openingBalanceMinor, amount: v.openingBalance }), {
    message: "Trimite soldul inițial o singură dată.",
  });

export const accountUpdateSchema = z
  .strictObject({
    name: requiredName(ACCOUNT_NAME_MAX).optional(),
    type: z.enum(ACCOUNT_TYPES).optional(),
    // Moneda se schimbă doar pentru un cont fără tranzacții.
    currency: z.enum(DB_CURRENCIES).optional(),
    openingBalanceMinor: signedMinorSchema.optional(),
    openingBalance: amountTextSchema.optional(),
    bankCode: bankCodeSchema,
    ownerUserId: idSchema.nullable().optional(),
  })
  .refine((v) => notBoth({ amountMinor: v.openingBalanceMinor, amount: v.openingBalance }), {
    message: "Trimite soldul inițial o singură dată.",
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nimic de modificat.",
  });

export const accountListSchema = z
  .strictObject({ includeArchived: z.boolean().optional() })
  .optional();

export type AccountCreateInput = z.input<typeof accountCreateSchema>;
export type AccountUpdateInput = z.input<typeof accountUpdateSchema>;

/** Contul, cu soldul curent CALCULAT (nu stocat, 6.1), ca `bigint` în unități minore. */
export type AccountView = Readonly<{
  id: string;
  name: string;
  type: (typeof ACCOUNT_TYPES)[number];
  currency: Currency;
  openingBalanceMinor: bigint;
  balanceMinor: bigint;
  bankCode: string | null;
  ownerUserId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

/** Totalul soldurilor conturilor active într-o monedă (fără conversii, 5.1). */
export type CurrencyTotal = Readonly<{ currency: Currency; balanceMinor: bigint }>;

export type AccountList = Readonly<{ accounts: AccountView[]; totals: CurrencyTotal[] }>;

export type AccountJson = Omit<
  AccountView,
  "openingBalanceMinor" | "balanceMinor" | "archivedAt" | "createdAt" | "updatedAt"
> & {
  openingBalanceMinor: number;
  balanceMinor: number;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Forma JSON (6.4): sumele ca întregi prin `toJson` (aruncă `MoneyOverflowError` peste 2^53).
 */
export function accountToJson(a: AccountView): AccountJson {
  const amount = (minor: bigint): MoneyJson["amountMinor"] =>
    toJson(money(minor, a.currency)).amountMinor;
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    currency: a.currency,
    openingBalanceMinor: amount(a.openingBalanceMinor),
    balanceMinor: amount(a.balanceMinor),
    bankCode: a.bankCode,
    ownerUserId: a.ownerUserId,
    archived: a.archivedAt !== null,
    archivedAt: a.archivedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export function currencyTotalToJson(t: CurrencyTotal): MoneyJson {
  return toJson(money(t.balanceMinor, t.currency));
}
