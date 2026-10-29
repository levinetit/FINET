import "server-only";

import { getConfig, type AppMode, type Config } from "@/lib/config";
import { NotImplementedError } from "@/lib/errors";
import type { Money } from "@/lib/money";

/**
 * Drepturile unei gospodării (master prompt 3.3). Logica de business nu verifică niciodată
 * direct `APP_MODE` sau Stripe: întreabă acest modul.
 *
 * - `personal`: `can` → `true` pentru orice funcție; `limit` → doar limitele tehnice din config.
 * - `saas`: neimplementat până în Faza 11 → `NotImplementedError` (nu simulăm planuri).
 *
 * Funcțiile sunt asincrone de acum, ca implementarea `saas` (care citește planul din bază) să
 * nu schimbe semnătura. Modulul NU verifică apartenența utilizatorului la gospodărie: aceea se
 * face înainte, la autorizare.
 */

/** Identificatorul unei funcții: `<domeniu>.<acțiune>`, de exemplu `documents.process`. */
export type Feature = `${string}.${string}`;

/** Limitele tehnice disponibile și tipul fiecăreia. */
export type LimitValues = {
  /** Documente procesate cu AI pe zi, per gospodărie. */
  "ai.dailyDocuments": number;
  /** Bugetul lunar global pentru furnizorii AI externi (unități minore). */
  "ai.monthlyBudget": Money;
  /** Cota de stocare, în MB. */
  "storage.quotaMb": number;
};
export type LimitKey = keyof LimitValues;

const LIMIT_KEYS: readonly LimitKey[] = [
  "ai.dailyDocuments",
  "ai.monthlyBudget",
  "storage.quotaMb",
];
const FEATURE = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;

export type Entitlements = Readonly<{
  can(householdId: string, feature: Feature): Promise<boolean>;
  limit<K extends LimitKey>(householdId: string, key: K): Promise<LimitValues[K]>;
}>;

function assertHouseholdId(householdId: unknown): asserts householdId is string {
  if (typeof householdId !== "string" || householdId.trim() === "") {
    throw new TypeError("householdId lipsește.");
  }
}

function saasNotImplemented(): never {
  throw new NotImplementedError("Entitlements pentru modul `saas` vin în Faza 11.");
}

/** Construiește implementarea pentru un mod și o configurație date (folosit și de teste). */
export function createEntitlements(
  mode: AppMode,
  limits: Readonly<{
    ai: Pick<Config["ai"], "dailyDocumentLimit" | "monthlyBudget">;
    storage: Config["storage"];
  }>,
): Entitlements {
  const values: LimitValues = {
    "ai.dailyDocuments": limits.ai.dailyDocumentLimit,
    "ai.monthlyBudget": limits.ai.monthlyBudget,
    "storage.quotaMb": limits.storage.quotaMb,
  };

  return Object.freeze({
    async can(householdId: string, feature: Feature): Promise<boolean> {
      assertHouseholdId(householdId);
      if (typeof feature !== "string" || !FEATURE.test(feature)) {
        throw new TypeError("Funcție (feature) invalidă.");
      }
      if (mode === "saas") saasNotImplemented();
      return true;
    },

    async limit<K extends LimitKey>(householdId: string, key: K): Promise<LimitValues[K]> {
      assertHouseholdId(householdId);
      if (!LIMIT_KEYS.includes(key)) throw new TypeError("Limită necunoscută.");
      if (mode === "saas") saasNotImplemented();
      return values[key];
    },
  });
}

// Construcția e ieftină; configurația e deja memorată de `getConfig()`.
function current(): Entitlements {
  const config = getConfig();
  return createEntitlements(config.appMode, config);
}

/** Poate gospodăria folosi funcția? */
export function can(householdId: string, feature: Feature): Promise<boolean> {
  return current().can(householdId, feature);
}

/** Valoarea unei limite pentru gospodărie. */
export function limit<K extends LimitKey>(householdId: string, key: K): Promise<LimitValues[K]> {
  return current().limit(householdId, key);
}
