import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, finet, updatedAt } from "./finet";
import { feedback } from "./admin";
import { users } from "./auth";
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
export const SUBSCRIPTION_PROVIDERS = ["manual", "stripe", "founder", "reward"] as const;

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
    check(
      "subscriptions_provider_valid",
      sql`${t.provider} in ('manual', 'stripe', 'founder', 'reward')`,
    ),
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

/**
 * Faza 12-C (ADR 0037): recomandări. Recompensele (planul acordat, zilele, plafoanele) sunt DATE
 * ale operatorului, într-un singur rând; implicit totul e 0 / lipsă = recompensele sunt oprite
 * (FAIL CLOSED). Scrise doar de operator (`finet_migrator`); aplicația le citește doar prin
 * funcțiile SECURITY DEFINER din migrația 0025.
 */
export const referralSettings = finet.table(
  "referral_settings",
  {
    /** Singurul rând (`id = true`). */
    id: boolean("id").primaryKey().default(true),
    /** Codul planului acordat ca recompensă; lipsă = oprit. */
    rewardPlanCode: text("reward_plan_code"),
    /** Zile pentru cel invitat; 0 = nimic. */
    inviteeDays: integer("invitee_days").notNull().default(0),
    /** Zile pentru cel care invită, per invitat înregistrat; 0 = nimic. */
    inviterDays: integer("inviter_days").notNull().default(0),
    /** Câte recompense primește un utilizator ca invitator; 0 = niciuna. */
    inviterMaxRewards: integer("inviter_max_rewards").notNull().default(0),
    /** Cât timp după crearea contului se poate folosi un cod (ore). */
    redeemWindowHours: integer("redeem_window_hours").notNull().default(24),
    /** Zile acordate pentru un feedback validat de administrator (12-C, felia 3); 0 = nimic. */
    feedbackDays: integer("feedback_days").notNull().default(0),
    /** Câte recompense de feedback se acordă în total (plafon global); 0 = niciuna. */
    feedbackMaxRewards: integer("feedback_max_rewards").notNull().default(0),
  },
  (t) => [
    check("referral_settings_single", sql`${t.id}`),
    check("referral_settings_invitee_days", sql`${t.inviteeDays} between 0 and 3650`),
    check("referral_settings_inviter_days", sql`${t.inviterDays} between 0 and 3650`),
    check("referral_settings_inviter_max", sql`${t.inviterMaxRewards} between 0 and 1000`),
    check("referral_settings_window", sql`${t.redeemWindowHours} between 1 and 720`),
    check("referral_settings_feedback_days", sql`${t.feedbackDays} between 0 and 3650`),
    check("referral_settings_feedback_max", sql`${t.feedbackMaxRewards} between 0 and 100000`),
  ],
);

/** Codul de recomandare al unui utilizator (`FIN-XXXXXX`), creat la prima cerere. */
export const referralCodes = finet.table(
  "referral_codes",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("referral_codes_code_key").on(t.code),
    check("referral_codes_shape", sql`${t.code} ~ '^FIN-[A-HJ-NP-Z2-9]{6}$'`),
  ],
);

/** O recomandare: un invitat poate folosi un singur cod, o singură dată. */
export const referrals = finet.table(
  "referrals",
  {
    inviteeUserId: uuid("invitee_user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    inviterUserId: uuid("inviter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    inviteeRewarded: boolean("invitee_rewarded").notNull().default(false),
    inviterRewarded: boolean("inviter_rewarded").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("referrals_inviter_idx").on(t.inviterUserId),
    check("referrals_not_self", sql`${t.inviteeUserId} <> ${t.inviterUserId}`),
  ],
);

/**
 * Recompensa pentru feedback (12-C, felia 3): cel mult UNA pe utilizator (cheie primară pe
 * `user_id`). Scrisă doar de funcția `finet.admin_reward_feedback`.
 */
export const feedbackRewards = finet.table("feedback_rewards", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  feedbackId: uuid("feedback_id").references(() => feedback.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});
