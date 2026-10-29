import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ro } from "@/messages/ro";
import { listLists } from "@/modules/shopping/shopping.service";

import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { PageHeader } from "../page-header";

import { ListCreateForm } from "./list-create-form";

export const metadata: Metadata = { title: ro.shopping.title };

type SearchParams = Promise<{ status?: string }>;

/**
 * Listele de cumpărături (F10-A, ADR 0022): comune (toți membrii) și personale (doar tu), active
 * sau arhivate. Citirea trece prin serviciu, sub RLS-ul utilizatorului: lista personală a altui
 * membru nu apare. Actualizările celorlalți membri vin prin fluxul live al aplicației.
 */
export default async function ShoppingListsPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const { status: rawStatus } = await searchParams;
  const status = rawStatus === "archived" ? "archived" : "active";
  const page = await requireLedgerPage("/shopping-lists");
  const t = ro.shopping;
  const header = <PageHeader eyebrow={t.eyebrow} title={t.title} usageStats={page.usageStats} />;
  if (!page.householdId) {
    return (
      <>
        {header}
        <Card>
          <p className="text-muted-foreground">{ro.ledger.noHousehold}</p>
        </Card>
      </>
    );
  }
  const householdId = page.householdId;
  const result = await load(() =>
    listLists({ db: page.session.runtime.db }, page.actor, householdId, { status }),
  );
  if (!result.ok) {
    return (
      <>
        {header}
        <Alert>{ro.ledger.loadError}</Alert>
      </>
    );
  }
  const lists = result.value;
  return (
    <>
      {header}
      <p className="mb-4 text-muted-foreground">{t.intro}</p>
      <div className="flex flex-col gap-4">
        <ListCreateForm />
        <nav aria-label={t.statusTabs} className="flex gap-2">
          {(["active", "archived"] as const).map((s) => (
            <Link
              key={s}
              href={s === "active" ? "/shopping-lists" : "/shopping-lists?status=archived"}
              aria-current={status === s ? "page" : undefined}
              className={cn(buttonClasses(status === s ? "default" : "outline", "sm"), "min-h-11")}
            >
              {s === "active" ? t.active : t.archived}
            </Link>
          ))}
        </nav>
        {lists.length === 0 ? (
          <Card>
            <p className="text-muted-foreground" data-testid="lists-empty">
              {status === "active" ? t.empty : t.emptyArchived}
            </p>
          </Card>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="lists">
            {lists.map((l) => (
              <li key={l.id}>
                <Link
                  href={`/shopping-lists/${l.id}`}
                  className="flex min-h-16 flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-4 py-3 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  data-testid="list-link"
                >
                  <span className="min-w-0 break-words font-semibold">{l.name}</span>
                  <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <span className="rounded-md bg-muted px-2 py-0.5 text-foreground">
                      {l.shared ? t.sharedBadge : t.personalBadge}
                    </span>
                    <span>{t.progress(l.checkedCount, l.itemCount)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
