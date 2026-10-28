import { z } from "zod";

import {
  ACCOUNT_TYPES,
  CATEGORY_KINDS,
  DB_CURRENCIES,
  HOUSEHOLD_ROLES,
  THEMES,
  TRANSACTION_SOURCES,
  TRANSACTION_TYPES,
  TRANSFER_DIRECTIONS,
} from "@/db/schema";
import { sessionViewSchema } from "@/modules/sessions/sessions.schema";

/**
 * Schemele RĂSPUNSURILOR API (OpenAPI, ADR 0005). Răspunsurile reale sunt construite de funcțiile
 * `*ToJson` din module; testele de integrare verifică răspunsurile reale cu aceste scheme
 * (`src/app/api/v1/contract.test.ts`), ca documentația să nu se depărteze de cod.
 */

const uuid = z.uuid();
const instant = z.iso.datetime().meta({ description: "Moment ISO 8601 în UTC." });
const date = z.iso.date().meta({ description: "Dată calendaristică `YYYY-MM-DD`." });
const minor = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)
  .meta({ description: "Sumă în unități minore (întreg, sub 2^53); niciodată zecimale." });
const currency = z.enum(DB_CURRENCIES);

export const errorSchema = z
  .strictObject({
    error: z.strictObject({
      code: z.string(),
      message: z.string(),
      fields: z.record(z.string(), z.string()).optional(),
      reason: z.string().optional(),
    }),
  })
  .meta({ title: "Error" });

export const moneySchema = z
  .strictObject({ amountMinor: minor, currency })
  .meta({ title: "Money" });

export const accountSchema = z
  .strictObject({
    id: uuid,
    name: z.string(),
    type: z.enum(ACCOUNT_TYPES),
    currency,
    openingBalanceMinor: minor,
    balanceMinor: minor.meta({ description: "Sold calculat (nu stocat)." }),
    bankCode: z.string().nullable(),
    ownerUserId: uuid.nullable(),
    archived: z.boolean(),
    archivedAt: instant.nullable(),
    createdAt: instant,
    updatedAt: instant,
  })
  .meta({ title: "Account" });

export const categorySchema = z
  .strictObject({
    id: uuid,
    name: z.string(),
    kind: z.enum(CATEGORY_KINDS),
    parentId: uuid.nullable(),
    icon: z.string().nullable(),
    color: z.string().nullable(),
    hidden: z.boolean(),
    isSystem: z.boolean(),
    systemKey: z.string().nullable(),
  })
  .meta({ title: "Category" });

export const transactionSchema = z
  .strictObject({
    id: uuid,
    accountId: uuid,
    categoryId: uuid.nullable(),
    type: z.enum(TRANSACTION_TYPES),
    amountMinor: minor,
    currency,
    occurredOn: date,
    description: z.string().nullable(),
    merchant: z.string().nullable(),
    notes: z.string().nullable(),
    source: z.enum(TRANSACTION_SOURCES),
    transferGroupId: uuid.nullable(),
    transferDirection: z.enum(TRANSFER_DIRECTIONS).nullable(),
    createdByUserId: uuid.nullable(),
    createdAt: instant,
    updatedAt: instant,
  })
  .meta({ title: "Transaction" });

const transferLeg = z.strictObject({
  transactionId: uuid,
  accountId: uuid,
  amountMinor: minor,
  currency,
});

export const transferSchema = z
  .strictObject({
    id: uuid.meta({ description: "`transfer_group_id`." }),
    from: transferLeg,
    to: transferLeg,
    occurredOn: date,
    description: z.string().nullable(),
    notes: z.string().nullable(),
    createdByUserId: uuid.nullable(),
    createdAt: instant,
  })
  .meta({ title: "Transfer" });

export const householdSummarySchema = z
  .strictObject({
    id: uuid,
    name: z.string(),
    defaultCurrency: currency,
    timezone: z.string(),
    role: z.enum(HOUSEHOLD_ROLES),
    current: z.boolean(),
    joinedAt: instant,
  })
  .meta({ title: "HouseholdSummary" });

export const householdDetailSchema = householdSummarySchema
  .extend({
    members: z.array(
      z.strictObject({
        userId: uuid,
        name: z.string(),
        role: z.enum(HOUSEHOLD_ROLES),
        joinedAt: instant,
      }),
    ),
  })
  .meta({ title: "HouseholdDetail" });

export const consentStateSchema = z
  .strictObject({
    kind: z.enum(["usageStats", "externalAi", "externalAiStatements"]),
    granted: z.boolean(),
    grantedAt: instant.nullable(),
    revokedAt: instant.nullable(),
  })
  .meta({ title: "ConsentState" });

export const meSchema = z
  .strictObject({
    user: z.strictObject({
      id: uuid,
      email: z.string(),
      name: z.string(),
      emailVerified: z.boolean(),
      isPlatformAdmin: z.boolean(),
      createdAt: instant,
    }),
    preferences: z.strictObject({
      locale: z.string(),
      timezone: z.string(),
      defaultCurrency: currency,
      theme: z.enum(THEMES),
    }),
    household: z
      .strictObject({
        id: uuid,
        name: z.string(),
        defaultCurrency: currency,
        timezone: z.string(),
        role: z.enum(HOUSEHOLD_ROLES),
      })
      .nullable(),
  })
  .meta({ title: "Me" });

export const sessionSchema = sessionViewSchema.meta({ title: "Session" });

/** `{ data }` */
export const dataOf = <T extends z.ZodType>(schema: T) => z.strictObject({ data: schema });
