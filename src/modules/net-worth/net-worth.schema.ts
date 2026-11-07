import { z } from "zod";

import { type Currency, money, toJson } from "@/lib/money";
import { amountTextSchema, dateSchema, signedMinorSchema } from "@/modules/ledger/input";

import type { AccountValue, NetWorth, NetWorthPoint } from "./net-worth";

/** Averea netă și evaluările (modernizare 2026, pasul G; ADR 0046): intrări Zod și forma JSON. */

export const VALUATION_NOTE_MAX = 200;
export const HISTORY_MONTHS_DEFAULT = 12;
export const HISTORY_MONTHS_MAX = 60;

export const netWorthQuerySchema = z
  .strictObject({ months: z.number().int().min(1).max(HISTORY_MONTHS_MAX).optional() })
  .optional();

/** O evaluare: valoarea semnată (activ +, pasiv −), ca întreg în unități minore sau ca text. */
export const valuationCreateSchema = z
  .strictObject({
    valuedOn: dateSchema,
    valueMinor: signedMinorSchema.optional(),
    value: amountTextSchema.optional(),
    note: z
      .string()
      .max(VALUATION_NOTE_MAX * 2)
      .transform((v) => v.trim())
      .refine((v) => v.length <= VALUATION_NOTE_MAX, {
        message: `Nota poate avea cel mult ${VALUATION_NOTE_MAX} de caractere.`,
      })
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .optional(),
  })
  .refine((v) => (v.valueMinor === undefined) !== (v.value === undefined), {
    message: "Trimite valoarea o singură dată (valueMinor sau value).",
  });

export type ValuationView = Readonly<{
  id: string;
  accountId: string;
  currency: Currency;
  valuedOn: string;
  valueMinor: bigint;
  note: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}>;

const j = (v: bigint, c: Currency) => toJson(money(v, c)).amountMinor;

export function valuationToJson(v: ValuationView) {
  return {
    id: v.id,
    accountId: v.accountId,
    currency: v.currency,
    valuedOn: v.valuedOn,
    valueMinor: j(v.valueMinor, v.currency),
    note: v.note,
    createdByUserId: v.createdByUserId,
    createdAt: v.createdAt.toISOString(),
  };
}

export type ValuationJson = ReturnType<typeof valuationToJson>;

const pointJson = (p: NetWorthPoint, c: Currency) => ({
  asOf: p.asOf,
  assetsMinor: j(p.assetsMinor, c),
  liabilitiesMinor: j(p.liabilitiesMinor, c),
  netMinor: j(p.netMinor, c),
});

const accountValueJson = (v: AccountValue, c: Currency) => ({
  accountId: v.accountId,
  name: v.name,
  type: v.type,
  kind: v.kind,
  valueMinor: j(v.valueMinor, c),
  basis: v.basis,
  valuedOn: v.valuedOn,
  archived: v.archived,
});

export function netWorthToJson(n: NetWorth) {
  const c = n.currency;
  return {
    currency: c,
    asOf: n.asOf,
    current: pointJson(n.current, c),
    byType: n.byType.map((b) => ({
      type: b.type,
      kind: b.kind,
      valueMinor: j(b.valueMinor, c),
      accounts: b.accounts.map((a) => accountValueJson(a, c)),
    })),
    history: n.history.map((p) => pointJson(p, c)),
  };
}

export type NetWorthJson = ReturnType<typeof netWorthToJson>;

export type NetWorthView = Readonly<{ asOf: string; currencies: readonly NetWorth[] }>;

export function netWorthViewToJson(v: NetWorthView) {
  return { asOf: v.asOf, currencies: v.currencies.map(netWorthToJson) };
}

export type NetWorthViewJson = ReturnType<typeof netWorthViewToJson>;
