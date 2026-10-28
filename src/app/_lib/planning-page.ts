import "server-only";

import { type Month } from "@/lib/calendar";
import { type PlanningDeps, resolveMonth } from "@/modules/budgets/budgets.service";
import { inHousehold } from "@/modules/ledger/context";

import type { LedgerPage } from "./ledger-page";
import { pickMonth } from "./planning-ui";

/**
 * Luna unei pagini de planificare (F3-C). Paginile citesc serviciile direct (ADR 0006), deci
 * fereastra de 60 de luni a API-ului (`monthOf` din `planning-handlers.ts`) se aplică AICI:
 * luna curentă vine din fusul gospodăriei (`resolveMonth`, ca în API), iar `?month=` invalid sau
 * în afara ferestrei dă luna curentă și un mesaj (`invalid`), nu o eroare.
 */
export async function pageMonth(
  page: LedgerPage,
  householdId: string,
  raw: string | string[] | undefined,
  now: () => Date = () => new Date(),
): Promise<Readonly<{ month: Month; current: Month; invalid: boolean }>> {
  const deps: PlanningDeps = { db: page.session.runtime.db, now };
  const current = await inHousehold(deps, page.actor, householdId, (tx, m) =>
    resolveMonth(tx, m.householdId, undefined, now),
  );
  const picked = pickMonth(raw, current);
  return { ...picked, current };
}
