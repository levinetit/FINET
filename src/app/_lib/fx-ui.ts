import "server-only";

import type { DbOrTx } from "@/db";
import { approxTotal } from "@/lib/fx";
import { type Currency, type MoneyJson, isCurrency, money, toJson } from "@/lib/money";
import { latestRates } from "@/modules/fx/fx.service";

import type { ApproxJson } from "../(app)/accounts/accounts-list";

/**
 * Totalul aproximativ în moneda de bază pentru pagini (ADR 0049): citește cursurile cele mai
 * recente (o interogare mică; `null` fără cursuri sau cu o singură monedă) și convertește pe
 * server, în bigint. Nicio eroare nu blochează pagina (se întoarce `null`).
 */
export async function approxForPage(
  db: DbOrTx,
  totals: readonly MoneyJson[],
  base: string,
  onOrBefore?: string,
): Promise<ApproxJson | null> {
  if (!isCurrency(base) || totals.length < 2) return null;
  try {
    const table = await latestRates(db, onOrBefore);
    if (!table) return null;
    const r = approxTotal(
      totals.map((t) => money(BigInt(t.amountMinor), t.currency as Currency)),
      base,
      table,
    );
    if (!r) return null;
    return {
      currency: r.currency,
      amountMinor: toJson(money(r.amountMinor, r.currency)).amountMinor,
      rateDate: r.rateDate,
      missing: r.missing,
    };
  } catch {
    return null;
  }
}
