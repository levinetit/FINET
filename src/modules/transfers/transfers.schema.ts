import { z } from "zod";

import { type Currency, money, toJson } from "@/lib/money";
import {
  amountTextSchema,
  dateSchema,
  idSchema,
  notBoth,
  optionalText,
  positiveMinorSchema,
} from "@/modules/ledger/input";
import { DESCRIPTION_MAX, NOTES_MAX } from "@/modules/transactions/transactions.schema";

/**
 * Transferurile între conturile aceleiași gospodării (5.1): două rânduri `transfer` legate prin
 * `transfer_group_id`. Aceeași monedă → o singură sumă (`amountMinor` sau `amount`); monede
 * diferite → ambele sume explicit (`amountFromMinor`, `amountToMinor`), fără curs implicit.
 */

const amounts = {
  amountMinor: positiveMinorSchema.optional(),
  amount: amountTextSchema.optional(),
  amountFromMinor: positiveMinorSchema.optional(),
  amountToMinor: positiveMinorSchema.optional(),
};

type Amounts = {
  amountMinor?: number;
  amount?: string;
  amountFromMinor?: number;
  amountToMinor?: number;
};

/** Fie suma unică, fie perechea from/to; nu amândouă. */
function amountShape(v: Amounts): boolean {
  const single = v.amountMinor !== undefined || v.amount !== undefined;
  const pair = v.amountFromMinor !== undefined || v.amountToMinor !== undefined;
  return !(single && pair) && notBoth(v);
}

const shapeMessage = {
  message: "Trimite fie suma (amountMinor sau amount), fie amountFromMinor și amountToMinor.",
} as const;

export const transferCreateSchema = z
  .strictObject({
    fromAccountId: idSchema,
    toAccountId: idSchema,
    ...amounts,
    occurredOn: dateSchema,
    description: optionalText(DESCRIPTION_MAX),
    notes: optionalText(NOTES_MAX),
  })
  .refine(amountShape, shapeMessage)
  .refine((v) => v.fromAccountId !== v.toAccountId, {
    message: "Transferul se face între două conturi diferite.",
    path: ["toAccountId"],
  });

export const transferUpdateSchema = z
  .strictObject({
    ...amounts,
    occurredOn: dateSchema.optional(),
    description: optionalText(DESCRIPTION_MAX),
    notes: optionalText(NOTES_MAX),
  })
  .refine(amountShape, shapeMessage)
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nimic de modificat.",
  });

export type TransferLeg = Readonly<{
  transactionId: string;
  accountId: string;
  amountMinor: bigint;
  currency: Currency;
}>;

export type TransferView = Readonly<{
  id: string;
  from: TransferLeg;
  to: TransferLeg;
  occurredOn: string;
  description: string | null;
  notes: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}>;

type LegJson = Omit<TransferLeg, "amountMinor"> & { amountMinor: number };

export type TransferJson = Omit<TransferView, "from" | "to" | "createdAt"> & {
  from: LegJson;
  to: LegJson;
  createdAt: string;
};

function legToJson(l: TransferLeg): LegJson {
  return { ...l, amountMinor: toJson(money(l.amountMinor, l.currency)).amountMinor };
}

export function transferToJson(t: TransferView): TransferJson {
  return {
    ...t,
    from: legToJson(t.from),
    to: legToJson(t.to),
    createdAt: t.createdAt.toISOString(),
  };
}
