import type { ChatUsage } from "./client";

/**
 * Estimarea costului unui apel AI (Faza 6, F6-B; ADR 0014), DOAR în întregi (bigint), în
 * unitățile minore ale monedei bugetului. Rotunjirea e mereu în sus și cel puțin 1 unitate per
 * apel (un apel Gemini Flash costă sub un cent: rotunjit în jos ar fi 0 și bugetul n-ar opri
 * nimic). Fără `usage` valid de la furnizor se contează MAXIMUL estimat (fail-closed).
 */

export type Pricing = Readonly<{ inputPerMTokMinor: bigint; outputPerMTokMinor: bigint }>;

const MILLION = 1_000_000n;

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Costul pentru un număr de tokeni (≥ 1 unitate minoră dacă tarifele nu sunt 0). */
export function costOfTokens(
  pricing: Pricing,
  promptTokens: number,
  completionTokens: number,
): bigint {
  const raw =
    BigInt(Math.max(0, Math.trunc(promptTokens))) * pricing.inputPerMTokMinor +
    BigInt(Math.max(0, Math.trunc(completionTokens))) * pricing.outputPerMTokMinor;
  if (pricing.inputPerMTokMinor === 0n && pricing.outputPerMTokMinor === 0n) return 0n;
  const cost = ceilDiv(raw, MILLION);
  return cost < 1n ? 1n : cost;
}

/** Tokenii de intrare estimați pesimist (decizia mea): ~1 token / 2 caractere + 2000 per imagine. */
export function estimatePromptTokens(textChars: number, images: number): number {
  return Math.ceil(textChars / 2) + images * 2000 + 200;
}

/** Plafonul pesimist al unui apel: intrarea estimată + tot `maxTokens` la ieșire. */
export function maxCostOf(
  pricing: Pricing,
  textChars: number,
  images: number,
  maxTokens: number,
): bigint {
  return costOfTokens(pricing, estimatePromptTokens(textChars, images), maxTokens);
}

/** Costul real (din `usage`) sau, dacă lipsește, plafonul pesimist. */
export function actualCostOf(
  pricing: Pricing,
  usage: ChatUsage | null,
  fallbackMax: bigint,
): bigint {
  if (!usage) return fallbackMax;
  return costOfTokens(pricing, usage.promptTokens, usage.completionTokens);
}
