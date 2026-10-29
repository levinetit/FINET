import "server-only";

import { sql } from "drizzle-orm";

import type { DbOrTx } from "@/db";
import type { Money } from "@/lib/money";

/**
 * Bugetul lunar GLOBAL al apelurilor AI externe (`AI_MONTHLY_BUDGET`; master prompt 3.6; ADR
 * 0014). Workerul rulează ca `finet_app`, care nu vede contorul: îl atinge doar prin funcțiile
 * SECURITY DEFINER din 0009. Contorul doar crește: rezervarea pesimistă (plafonul estimat al
 * încercării) se face ÎNAINTEA fiecărei încercări, fără rambursare, deci bugetul nu poate fi
 * depășit nici de reîncercări, nici de mai multe workere (UPDATE atomic pe rândul lunii).
 * Ștergerea unei gospodării (care șterge `ai_calls`) nu eliberează nimic.
 */

/** Rezervă `costMinor` (≥ 1) din buget; `false` = bugetul nu permite (nimic nu pleacă). */
export async function reserveAiBudget(
  db: DbOrTx,
  costMinor: bigint,
  budget: Money,
): Promise<boolean> {
  if (budget.amountMinor <= 0n) return false;
  const cost = costMinor < 1n ? 1n : costMinor;
  const rows = (await db.execute(
    sql`select finet.ai_budget_reserve(${cost.toString()}::bigint, ${budget.amountMinor.toString()}::bigint, ${budget.currency}) as ok`,
  )) as unknown as { ok: boolean }[];
  return rows[0]?.ok === true;
}

/** Cât s-a rezervat în luna curentă (unități minore ale monedei bugetului). */
export async function aiBudgetSpent(db: DbOrTx, currency: Money["currency"]): Promise<bigint> {
  const rows = (await db.execute(
    sql`select finet.ai_budget_spent(${currency})::text as spent`,
  )) as unknown as { spent: string }[];
  return BigInt(rows[0]?.spent ?? "0");
}
