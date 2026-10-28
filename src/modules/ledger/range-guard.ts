import "server-only";

import { sql } from "drizzle-orm";

import type { Tx } from "@/db";
import { MAX_JSON_SAFE_MINOR, MoneyOverflowError } from "@/lib/money";

/**
 * Garda de interval a conturilor (revizuirea F2, LOW-2; ADR 0004 și 0005): după o scriere, pentru
 * fiecare cont atins, |sold inițial| + Σ amount_minor (TOATE rândurile, orice tip și sens) trebuie
 * să rămână ≤ 2^53 − 1. Suma brută mărginește soldul și orice total pe cont (venituri, cheltuieli,
 * transferuri), deci acestea pot fi trimise mereu exact în JSON. Altfel scrierea e anulată cu
 * `MoneyOverflowError` (→ 422 `amount_out_of_range` în API). ~901 sume la plafonul de 10^13 pe
 * același cont ar ajunge la 2^53; garda le oprește la scriere, nu abia la citire.
 *
 * Concurența: conturile se blochează `FOR NO KEY UPDATE`, în ordinea id-ului (fără deadlock între
 * două transferuri în sensuri opuse). Modul e compatibil cu `FOR KEY SHARE` luat de cheia străină
 * la inserarea tranzacției, deci nu blochează inserările, doar serializează gărzile: a doua
 * tranzacție calculează suma după COMMIT-ul primei și îi vede rândurile.
 *
 * Rămâne în afara gărzii (risc rezidual documentat): totalurile pe GOSPODĂRIE și monedă (dashboard,
 * rapoarte) adună mai multe conturi și pot depăși teoretic 2^53 − 1 (de exemplu zeci de conturi
 * aproape pline); atunci citirea răspunde 422 `amount_out_of_range`, nu 500 și nu o valoare
 * trunchiată.
 */
export async function assertAccountsWithinJsonRange(
  tx: Tx,
  householdId: string,
  accountIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(accountIds.map((id) => id.toLowerCase()))].sort();
  if (ids.length === 0) return;
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  await tx.execute(sql`
    select a.id from finet.accounts a
     where a.household_id = ${householdId} and a.id in (${idList})
     order by a.id
     for no key update`);
  const rows = await tx.execute<{ id: string; gross: string }>(sql`
    select a.id,
           (abs(a.opening_balance_minor)::numeric
             + coalesce((select sum(t.amount_minor) from finet.transactions t
                          where t.household_id = a.household_id and t.account_id = a.id), 0)
           )::text as gross
      from finet.accounts a
     where a.household_id = ${householdId} and a.id in (${idList})`);
  for (const row of rows) {
    const gross = BigInt(row.gross);
    if (gross > MAX_JSON_SAFE_MINOR) throw new MoneyOverflowError(gross);
  }
}
