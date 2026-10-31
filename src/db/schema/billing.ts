import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, finet, updatedAt } from "./finet";
import { households } from "./households";

/**
 * Faza 12-A (ADR 0035): planurile și abonamentele gospodăriilor, pentru implementarea `saas` a
 * `entitlements`. Limitele și prețurile sunt DATE, stabilite de operator (master prompt, Faza 12);
 * nimic nu este completat de migrație. Aplicația (rolul `finet_app`) doar CITEȘTE: planurile și
 * abonamentele se scriu de operator, ca `finet_migrator`, direct în bază (INFRA, secțiunea 4y),
 * ca un server web compromis să nu își poată acorda un plan. Webhook-urile Stripe (12-B) vor
 * scrie printr-o funcție dedicată.
 *
 * Migrația: `src/db/migrations/0023_plans_subscriptions.sql` (DDL-ul de aici, generat de
 * drizzle-kit, plus partea scrisă de mână: RLS ENABLE + FORCE, drepturile și `household_plan`).
 */

export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "expired",
] as const;
export const SUBSCRIPTION_PROVIDERS = ["manual", "stripe", "founder"] as const;

export const plans = finet.table(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Identificator stabil (`starter`, `pro`, `family`, `ultra`, `founder`…), folosit de operator și de Stripe. */
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** Planul unei gospodării fără abonament; cel mult unul (indice unic parțial). */
    isDefault: boolean("is_default").notNull().default(false),
    active: boolean("active").notNull().default(true),
    /** Limite numerice nenegative, cheile din `LimitKey` (ex. `ai.dailyDocuments`); lipsă = 0. */
    limits: jsonb("limits")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Funcții permise (`ask.finet`, `reports.custom`…); lipsă = interzis. */
    features: text("features")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("plans_code_key").on(t.code),
    uniqueIndex("plans_one_default")
      .on(t.isDefault)
      .where(sql`${t.isDefault}`),
    check("plans_code_shape", sql`${t.code} ~ '^[a-z][a-z0-9_-]{1,31}$'`),
    check(
      "plans_name_length",
      sql`char_length(${t.name}) >= 1 and char_length(${t.name}) <= 60 and ${t.name} = btrim(${t.name})`,
    ),
    check("plans_limits_object", sql`jsonb_typeof(${t.limits}) = 'object'`),
    check(
      "plans_features_shape",
      sql`cardinality(${t.features}) <= 50 and array_to_string(${t.features}, ',') ~ '^[A-Za-z0-9.,]*$' and array_position(${t.features}, '') is null`,
    ),
    check("plans_default_active", sql`not ${t.isDefault} or ${t.active}`),
  ],
);

export const subscriptions = finet.table(
  "subscriptions",
  {
    /** Un singur abonament curent pe gospodărie. */
    householdId: uuid("household_id")
      .primaryKey()
      .references(() => households.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id),
    status: text("status", { enum: SUBSCRIPTION_STATUSES }).notNull(),
    provider: text("provider", { enum: SUBSCRIPTION_PROVIDERS }).notNull(),
    /** Id-ul la furnizor (Stripe); unic pe furnizor, deci upsert-ul din 12-B e idempotent. */
    providerSubscriptionId: text("provider_subscription_id"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    trialEnd: timestamp("trial_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("subscriptions_plan_id_idx").on(t.planId),
    uniqueIndex("subscriptions_provider_sub_key")
      .on(t.provider, t.providerSubscriptionId)
      .where(sql`${t.providerSubscriptionId} is not null`),
    check(
      "subscriptions_status_valid",
      sql`${t.status} in ('trialing', 'active', 'past_due', 'canceled', 'expired')`,
    ),
    check("subscriptions_provider_valid", sql`${t.provider} in ('manual', 'stripe', 'founder')`),
    check(
      "subscriptions_provider_sub_length",
      sql`${t.providerSubscriptionId} is null or (char_length(${t.providerSubscriptionId}) >= 1 and char_length(${t.providerSubscriptionId}) <= 100)`,
    ),
    check(
      "subscriptions_stripe_has_id",
      sql`${t.provider} <> 'stripe' or ${t.providerSubscriptionId} is not null`,
    ),
  ],
);
