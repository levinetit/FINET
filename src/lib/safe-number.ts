import { MoneyOverflowError } from "./money";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * `bigint` → număr JSON, doar în intervalul sigur ±(2^53 − 1); altfel `MoneyOverflowError`
 * (HTTP 422 `amount_out_of_range`). Pentru valori derivate din sume (totaluri, prețuri pe
 * unitate, puncte de bază, cantități în miimi), ca și `toJson` pentru sumele propriu-zise.
 */
export function safe(v: bigint): number {
  if (v > MAX_SAFE || v < -MAX_SAFE) throw new MoneyOverflowError(v);
  return Number(v);
}
