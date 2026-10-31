import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import type { DbOrTx } from "@/db";
import { getConfig, type AppMode, type Config } from "@/lib/config";
import type { Money } from "@/lib/money";

/**
 * Drepturile unei gospodării (master prompt 3.3). Logica de business nu verifică niciodată
 * direct `APP_MODE` sau Stripe: întreabă acest modul.
 *
 * - `personal`: `can` → `true` pentru orice funcție; `limit` → doar limitele tehnice din config.
 *   NU citește niciodată tabelele de planuri.
 * - `saas` (Faza 12-A, ADR 0035): planul efectiv al gospodăriei vine din `finet.household_plan`
 *   (abonamentul viu, altfel planul implicit). FAIL CLOSED: fără plan (`none`), cu abonament
 *   expirat sau anulat (`read_only`), cu o limită lipsă sau invalidă în plan, `can` → `false` și
 *   `limit` → `0`. Nu aruncă și nu deschide niciodată accesul din cauza datelor lipsă.
 *
 * Funcțiile sunt asincrone, ca implementarea `saas` (care citește planul din bază) să nu schimbe
 * semnătura. Modulul NU verifică apartenența utilizatorului la gospodărie: aceea se face înainte,
 * la autorizare. `saas` cere un client de bază de date (`db`), altfel aruncă `TypeError`.
 */

/** Identificatorul unei funcții: `<domeniu>.<acțiune>`, de exemplu `documents.process`. */
export type Feature = `${string}.${string}`;

/** Limitele disponibile și tipul fiecăreia. */
export type LimitValues = {
  /** Documente procesate cu AI pe zi, per gospodărie. */
  "ai.dailyDocuments": number;
  /** Bugetul lunar global pentru furnizorii AI externi (unități minore). Global, nu pe plan. */
  "ai.monthlyBudget": Money;
  /** Cota de stocare, în MB. */
  "storage.quotaMb": number;
  /** Numărul maxim de membri ai gospodăriei (în `personal` nu există plafon pe plan). */
  "household.maxMembers": number;
};
export type LimitKey = keyof LimitValues;

const LIMIT_KEYS: readonly LimitKey[] = [
  "ai.dailyDocuments",
  "ai.monthlyBudget",
  "storage.quotaMb",
  "household.maxMembers",
];
/** Limitele numerice care vin din plan (restul sunt globale). */
type PlanLimitKey = Exclude<LimitKey, "ai.monthlyBudget">;
const FEATURE = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;

/** Fără plafon pe plan (în `personal`). */
export const UNLIMITED = Number.MAX_SAFE_INTEGER;

export type Entitlements = Readonly<{
  can(householdId: string, feature: Feature): Promise<boolean>;
  limit<K extends LimitKey>(householdId: string, key: K): Promise<LimitValues[K]>;
}>;

/** Starea planului efectiv (vezi `finet.household_plan`, migrația 0023). */
export type PlanState = "ok" | "read_only" | "none";

export type HouseholdPlan = Readonly<{
  code: string | null;
  state: PlanState;
  limits: Readonly<Partial<Record<string, number>>>;
  features: readonly string[];
}>;

const planRow = z.object({
  plan_code: z.string().nullable(),
  limits: z.record(z.string(), z.unknown()),
  features: z.array(z.string()),
  state: z.enum(["ok", "read_only", "none"]),
});

function assertHouseholdId(householdId: unknown): asserts householdId is string {
  if (typeof householdId !== "string" || householdId.trim() === "") {
    throw new TypeError("householdId lipsește.");
  }
}

/** Doar numere întregi nenegative contează; orice altceva dintr-un plan se ignoră (= 0). */
function validLimits(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) out[key] = value;
  }
  return out;
}

const NO_PLAN: HouseholdPlan = Object.freeze({
  code: null,
  state: "none",
  limits: Object.freeze({}),
  features: Object.freeze([]),
});

/**
 * Planul efectiv al gospodăriei, din baza de date. Orice răspuns neașteptat (fără rând, formă
 * invalidă) înseamnă „fără plan” (`none`): nimic permis. Eroarea bazei nu se înghite.
 */
export async function householdPlan(db: DbOrTx, householdId: string): Promise<HouseholdPlan> {
  assertHouseholdId(householdId);
  const rows = await db.execute(
    sql`select plan_code, limits, features, state from finet.household_plan(${householdId}::uuid)`,
  );
  const parsed = planRow.safeParse(rows[0]);
  if (!parsed.success) return NO_PLAN;
  return Object.freeze({
    code: parsed.data.plan_code,
    state: parsed.data.state,
    limits: Object.freeze(validLimits(parsed.data.limits)),
    features: Object.freeze([...parsed.data.features]),
  });
}

/** Construiește implementarea pentru un mod și o configurație date (folosit și de teste). */
export function createEntitlements(
  mode: AppMode,
  limits: Readonly<{
    ai: Pick<Config["ai"], "dailyDocumentLimit" | "monthlyBudget">;
    storage: Config["storage"];
  }>,
  db?: DbOrTx,
): Entitlements {
  const technical: LimitValues = {
    "ai.dailyDocuments": limits.ai.dailyDocumentLimit,
    "ai.monthlyBudget": limits.ai.monthlyBudget,
    "storage.quotaMb": limits.storage.quotaMb,
    "household.maxMembers": UNLIMITED,
  };

  function client(): DbOrTx {
    if (!db) throw new TypeError("entitlements `saas` cere un client de bază de date.");
    return db;
  }

  return Object.freeze({
    async can(householdId: string, feature: Feature): Promise<boolean> {
      assertHouseholdId(householdId);
      if (typeof feature !== "string" || !FEATURE.test(feature)) {
        throw new TypeError("Funcție (feature) invalidă.");
      }
      if (mode !== "saas") return true;
      const plan = await householdPlan(client(), householdId);
      return plan.state === "ok" && plan.features.includes(feature);
    },

    async limit<K extends LimitKey>(householdId: string, key: K): Promise<LimitValues[K]> {
      assertHouseholdId(householdId);
      if (!LIMIT_KEYS.includes(key)) throw new TypeError("Limită necunoscută.");
      if (mode !== "saas" || key === "ai.monthlyBudget") return technical[key];
      const plan = await householdPlan(client(), householdId);
      const value = plan.state === "ok" ? (plan.limits[key as PlanLimitKey] ?? 0) : 0;
      return value as LimitValues[K];
    },
  });
}

// Construcția e ieftină; configurația e deja memorată de `getConfig()`.
function current(db?: DbOrTx): Entitlements {
  const config = getConfig();
  return createEntitlements(config.appMode, config, db);
}

/** Poate gospodăria folosi funcția? (`db` e obligatoriu în `saas`.) */
export function can(householdId: string, feature: Feature, db?: DbOrTx): Promise<boolean> {
  return current(db).can(householdId, feature);
}

/** Valoarea unei limite pentru gospodărie. (`db` e obligatoriu în `saas`.) */
export function limit<K extends LimitKey>(
  householdId: string,
  key: K,
  db?: DbOrTx,
): Promise<LimitValues[K]> {
  return current(db).limit(householdId, key);
}
