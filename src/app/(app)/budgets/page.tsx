import type { Metadata } from "next";
import Link from "next/link";

import { ExportButton } from "@/components/planning/export-button";
import { MonthSelector } from "@/components/planning/month-selector";
import { BudgetAlert, BudgetLine, budgetName } from "@/components/planning/summary";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { ro } from "@/messages/ro";
import { budgetStatusToJson, budgetToJson } from "@/modules/budgets/budgets.schema";
import { getBudgetStatuses, listBudgets } from "@/modules/budgets/budgets.service";
import { listCategories } from "@/modules/categories/categories.service";

import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { formatMinor } from "../../_lib/ledger-ui";
import { pageMonth } from "../../_lib/planning-page";
import { exportPath, formatMonth } from "../../_lib/planning-ui";
import { PageHeader } from "../page-header";

export const metadata: Metadata = { title: ro.budgets.title };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Bugetele: starea lunii alese (semafor, cheltuit, rămas), avertizarea pentru cele galbene/roșii,
 * exportul CSV al lunii, bugetele arhivate. Bugetele personale ale altor membri nu apar (RLS).
 */
export default async function BudgetsPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const page = await requireLedgerPage("/budgets");
  const t = ro.budgets;
  const actions = page.householdId ? (
    <Link href="/budgets/new" className={buttonClasses()}>
      {t.add}
    </Link>
  ) : null;
  if (!page.householdId) {
    return (
      <>
        <PageHeader eyebrow={t.eyebrow} title={t.title} usageStats={page.usageStats} />
        <Card>
          <p className="text-muted-foreground">{ro.ledger.noHousehold}</p>
        </Card>
      </>
    );
  }
  const householdId = page.householdId;
  const { month: rawMonth } = await searchParams;
  const now = () => new Date();
  const selection = await pageMonth(page, householdId, rawMonth, now);
  const deps = { db: page.session.runtime.db, now };
  const result = await load(async () => {
    const [statuses, all, categories] = await Promise.all([
      getBudgetStatuses(deps, page.actor, householdId, { month: selection.month }),
      listBudgets(deps, page.actor, householdId, { includeArchived: true }),
      listCategories(deps, page.actor, householdId, { includeHidden: true }),
    ]);
    return {
      statuses: statuses.map(budgetStatusToJson),
      archived: all.filter((b) => b.archivedAt !== null).map(budgetToJson),
      categoryName: new Map(categories.map((c) => [c.id, c.name] as const)),
    };
  });

  return (
    <>
      <PageHeader
        eyebrow={t.eyebrow}
        title={t.title}
        usageStats={page.usageStats}
        actions={actions}
      />
      <div className="flex flex-col gap-4">
        <MonthSelector action="/budgets" month={selection.month} current={selection.current} />
        {selection.invalid ? <Alert tone="info">{ro.planning.invalidMonth}</Alert> : null}
        {!result.ok ? <Alert>{ro.ledger.loadError}</Alert> : null}
        {result.ok ? (
          <>
            <BudgetAlert statuses={result.value.statuses} month={selection.month} link={false} />
            <Card aria-labelledby="budgets-month">
              <CardHeader>
                <CardTitle id="budgets-month">{formatMonth(selection.month)}</CardTitle>
              </CardHeader>
              {result.value.statuses.length === 0 ? (
                <p className="text-muted-foreground" data-testid="budgets-empty">
                  {t.empty}
                </p>
              ) : (
                <ul className="flex flex-col gap-5" data-testid="budgets-list">
                  {result.value.statuses.map((s) => (
                    <li key={s.id}>
                      <BudgetLine
                        status={s}
                        name={budgetName(s, result.value.categoryName)}
                        href={`/budgets/${s.id}`}
                      />
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-4">
                <ExportButton
                  path={exportPath("budgets", { month: selection.month })}
                  label={t.exportCsv}
                  filename="finet-bugete.csv"
                  testId="export-budgets"
                />
              </div>
            </Card>
            {result.value.archived.length > 0 ? (
              <Card aria-labelledby="budgets-archived">
                <CardHeader>
                  <CardTitle id="budgets-archived">{t.archivedList}</CardTitle>
                </CardHeader>
                <ul className="flex flex-col divide-y divide-border">
                  {result.value.archived.map((b) => (
                    <li key={b.id}>
                      <Link
                        href={`/budgets/${b.id}`}
                        className="flex items-center justify-between gap-3 py-3 hover:text-primary"
                      >
                        <span className="font-semibold">
                          {budgetName(b, result.value.categoryName)}
                        </span>
                        <span className="font-mono tabular-nums">
                          {formatMinor(b.amountMinor, b.currency)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </>
        ) : null}
      </div>
    </>
  );
}
