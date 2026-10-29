import { z } from "zod";

import type { HouseholdRole } from "@/lib/authz";
import { CURRENCIES, type Currency, MAX_JSON_SAFE_MINOR, MoneyOverflowError } from "@/lib/money";
import {
  MAX_AMOUNT_MINOR,
  amountTextSchema,
  dateSchema,
  idSchema,
  optionalText,
  positiveMinorSchema,
} from "@/modules/ledger/input";

import type { CurrencyBalances } from "./split-math";

/**
 * Intrările și vederile serviciilor familiei (Faza 8, ADR 0016). Zod STRICT: o cheie necunoscută
 * (de exemplu `householdId`, `payerUserId`, `createdByUserId`) e respinsă — gospodăria vine din
 * sesiune, plătitorul și creatorul din actor. Sumele sunt întregi în unități minore.
 */

export const MAX_MEMBERS = 6;

// --- invitații --------------------------------------------------------------------------------

/** Valabilitatea implicită și maximă a unei invitații (CHECK-ul din bază: 168 h). */
export const INVITE_DEFAULT_HOURS = 72;
export const INVITE_MAX_HOURS = 168;
/** Câte invitații poate crea o gospodărie în 24 h (doar crescător: fără DELETE). */
export const INVITES_PER_DAY = 20;

export const inviteCreateSchema = z
  .strictObject({
    role: z.enum(["member", "owner"]).optional(),
    expiresInHours: z.number().int().min(1).max(INVITE_MAX_HOURS).optional(),
  })
  .optional();

/** Tokenul în clar: 32 de octeți CSPRNG în base64url (43 de caractere, fără padding). */
export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const inviteAcceptSchema = z.strictObject({
  token: z.string().max(64),
});

export type InviteStatus = "active" | "used" | "revoked" | "expired";

export type InviteView = Readonly<{
  id: string;
  role: HouseholdRole;
  status: InviteStatus;
  createdByUserId: string | null;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  usedByUserId: string | null;
  revokedAt: Date | null;
}>;

export type CreatedInvite = Readonly<{
  invite: InviteView;
  /** Tokenul în clar, afișat O SINGURĂ DATĂ (nu se stochează; în bază e doar SHA-256). */
  token: string;
}>;

export function inviteToJson(v: InviteView) {
  return {
    id: v.id,
    role: v.role,
    status: v.status,
    createdByUserId: v.createdByUserId,
    createdAt: v.createdAt.toISOString(),
    expiresAt: v.expiresAt.toISOString(),
    usedAt: v.usedAt?.toISOString() ?? null,
    usedByUserId: v.usedByUserId,
    revokedAt: v.revokedAt?.toISOString() ?? null,
  };
}

// --- membri și gospodăria activă --------------------------------------------------------------

export const roleChangeSchema = z.strictObject({ role: z.enum(["member", "owner"]) });
export const activeHouseholdSchema = z.strictObject({ householdId: idSchema });

export type MemberView = Readonly<{
  userId: string;
  name: string;
  role: HouseholdRole;
  joinedAt: Date;
}>;

export function memberToJson(m: MemberView) {
  return { userId: m.userId, name: m.name, role: m.role, joinedAt: m.joinedAt.toISOString() };
}

// --- împărțiri --------------------------------------------------------------------------------

const participants = z.array(idSchema).min(2).max(MAX_MEMBERS);

export const splitSetSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("equal"), userIds: participants }),
  z.strictObject({
    mode: z.literal("percent"),
    shares: z
      .array(
        z.strictObject({
          userId: idSchema,
          // Puncte de bază: 1% = 100, întregi, suma exact 10000 (verificată în serviciu).
          basisPoints: z.number().int().min(0).max(10_000),
        }),
      )
      .min(2)
      .max(MAX_MEMBERS),
  }),
  z.strictObject({
    mode: z.literal("fixed"),
    shares: z
      .array(
        z.strictObject({
          userId: idSchema,
          amountMinor: z.number().int().min(0).max(MAX_AMOUNT_MINOR, "Suma este prea mare."),
        }),
      )
      .min(2)
      .max(MAX_MEMBERS),
  }),
]);
export type SplitSetInput = z.infer<typeof splitSetSchema>;

export type SplitView = Readonly<{
  transactionId: string;
  payerUserId: string;
  currency: Currency;
  totalMinor: bigint;
  shares: ReadonlyArray<Readonly<{ userId: string; shareMinor: bigint }>>;
  createdAt: Date;
}>;

export const splitListSchema = z
  .strictObject({ limit: z.number().int().min(1).max(100).optional() })
  .optional();

// --- decontări --------------------------------------------------------------------------------

export const settlementCreateSchema = z
  .strictObject({
    fromUserId: idSchema,
    toUserId: idSchema,
    amountMinor: positiveMinorSchema.optional(),
    amount: amountTextSchema.optional(),
    currency: z.enum(CURRENCIES),
    settledOn: dateSchema,
    note: optionalText(200),
  })
  .refine((v) => (v.amountMinor === undefined) !== (v.amount === undefined), {
    message: "Trimite fie amountMinor, fie amount.",
  })
  .refine((v) => v.fromUserId !== v.toUserId, {
    message: "Decontarea e între doi membri diferiți.",
  });

export const settlementListSchema = z
  .strictObject({
    includeCancelled: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .optional();

export type SettlementView = Readonly<{
  id: string;
  fromUserId: string;
  toUserId: string;
  amountMinor: bigint;
  currency: Currency;
  settledOn: string;
  note: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
}>;

// --- JSON (garda 2^53 la ieșire) ----------------------------------------------------------------

/** `bigint` → număr JSON, doar sub 2^53 (altfel `MoneyOverflowError` → 422 în API). */
export function minorToJson(value: bigint): number {
  if (value > MAX_JSON_SAFE_MINOR || value < -MAX_JSON_SAFE_MINOR) {
    throw new MoneyOverflowError(value);
  }
  return Number(value);
}

export function splitToJson(v: SplitView) {
  return {
    transactionId: v.transactionId,
    payerUserId: v.payerUserId,
    currency: v.currency,
    totalMinor: minorToJson(v.totalMinor),
    shares: v.shares.map((s) => ({ userId: s.userId, shareMinor: minorToJson(s.shareMinor) })),
    createdAt: v.createdAt.toISOString(),
  };
}

export function settlementToJson(v: SettlementView) {
  return {
    id: v.id,
    fromUserId: v.fromUserId,
    toUserId: v.toUserId,
    amountMinor: minorToJson(v.amountMinor),
    currency: v.currency,
    settledOn: v.settledOn,
    note: v.note,
    createdByUserId: v.createdByUserId,
    createdAt: v.createdAt.toISOString(),
    cancelledAt: v.cancelledAt?.toISOString() ?? null,
    cancelledByUserId: v.cancelledByUserId,
  };
}

export type BalancesView = Readonly<{
  currencies: readonly CurrencyBalances[];
  /** Rezumatul utilizatorului curent pe monedă: „Ai de dat” / „Ai de primit”. */
  me: ReadonlyArray<Readonly<{ currency: Currency; owesMinor: bigint; owedMinor: bigint }>>;
}>;

export function balancesToJson(v: BalancesView) {
  return {
    currencies: v.currencies.map((c) => ({
      currency: c.currency,
      pairs: c.pairs.map((p) => ({
        debtorUserId: p.debtorUserId,
        creditorUserId: p.creditorUserId,
        amountMinor: minorToJson(p.amountMinor),
      })),
      members: c.members.map((m) => ({ userId: m.userId, netMinor: minorToJson(m.netMinor) })),
    })),
    me: v.me.map((m) => ({
      currency: m.currency,
      owesMinor: minorToJson(m.owesMinor),
      owedMinor: minorToJson(m.owedMinor),
    })),
  };
}
