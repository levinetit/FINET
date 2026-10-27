import "server-only";

import { sql } from "drizzle-orm";

import { type Tx } from "./rls";

/**
 * Crearea unei gospodării: singura cale e funcția SQL `finet.create_household` (0001_rls.sql),
 * care inserează ATOMIC gospodăria și apartenența `owner` a utilizatorului DIN CONTEXTUL RLS al
 * tranzacției (`withRls({ userId }, ...)`). Aplicația nu are INSERT pe `households`.
 * Fără utilizator în context, baza aruncă eroarea `42501`.
 */
export type NewHousehold = Readonly<{
  name: string;
  defaultCurrency?: "RON" | "EUR" | "USD";
  timezone?: string;
}>;

export async function createHousehold(tx: Tx, input: NewHousehold): Promise<string> {
  const rows = await tx.execute<{ id: string }>(
    sql`select finet.create_household(${input.name}, ${input.defaultCurrency ?? "RON"}, ${
      input.timezone ?? "Europe/Bucharest"
    }) as id`,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("create_household nu a întors un id");
  return id;
}
