import type { Metadata } from "next";

import { ExportButton } from "@/components/planning/export-button";
import { MonthSelector } from "@/components/planning/month-selector";
import { BudgetLine, GoalLine, budgetName } from "@/components/planning/summary";
import { Alert } from "@/components/ui/alert";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { monthBounds } from "@/lib/calendar";
import type { Currency } from "@/lib/money";
import { ro } from "@/messages/ro";
import { listCategories } from "@/modules/categories/categories.service";
import { monthlyReportToJson } from "@/modules/reports/reports.schema";
import { getMonthlyReport } from "@/modules/reports/reports.service";

import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { formatMinor } from "../../_lib/ledger-ui";
import { pageMonth } from "../../_lib/planning-page";
import { exportPath, formatMonth } from "../../_lib/planning-ui";
import { PageHeader } from "../page-header";

export const metadata: Metadata = { title: ro.reports.title };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Raportul lunar (Faza 3; PDF/Excel în Faza 10): totalurile pe monedă, toate categoriile cu
 * subcategoriile, comercianții principali, bugetele și obiectivele, plus exporturile CSV
 * (tranzacțiile lunii, obiectivele, bugetele lunii) cu `dialect=ro`.
 */
export default async function ReportsPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const page = await requireLedgerPage("/reports");
  const t = ro.reports;
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
    const [report, categories] = await Promise.all([
      getMonthlyReport(deps, page.actor, householdId, { month: selection.month }),
      listCategories(deps, page.actor, householdId, { includeHidden: true }),
    ]);
    return {
      report: monthlyReportToJson(report),
      categoryName: new Map(categories.map((c) => [c.id, c.name] as const)),
    };
  });
  const bounds = monthBounds(selection.month);
  const name = (n: string | null) => n ?? ro.dashboard.uncategorized;

  return (
    <>
      <PageHeader
        eyebrow={t.eyebrow}
        title={`${t.title} · ${formatMonth(selection.month)}`}
        usageStats={page.usageStats}
        actions={
          <MonthSelector action="/reports" month={selection.month} current={selection.current} />
        }
      />
      <div className="flex flex-col gap-4">
        {selection.invalid ? <Alert tone="info">{ro.planning.invalidMonth}</Alert> : null}
        {!result.ok ? <Alert>{ro.ledger.loadError}</Alert> : null}
        {result.ok && result.value.report.currencies.length === 0 ? (
          <Card>
            <p className="text-muted-foreground" data-testid="report-empty">
              {t.empty}
            </p>
          </Card>
        ) : null}
        {result.ok
          ? result.value.report.currencies.map((c) => {
              const cur = c.currency as Currency;
              return (
                <Card
                  key={c.currency}
                  aria-labelledby={`report-${c.currency}`}
                  data-testid={`report-${c.currency}`}
                >
                  <CardHeader>
                    <CardTitle id={`report-${c.currency}`}>
                      {t.totals} ({c.currency})
                    </CardTitle>
                  </CardHeader>
                  <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    {(
                      [
                        [ro.dashboard.income, formatMinor(c.totals.incomeMinor, cur), "income"],
                        [ro.dashboard.expense, formatMinor(c.totals.expenseMinor, cur), "expense"],
                        [ro.dashboard.net, formatMinor(c.totals.netMinor, cur), "net"],
                        [ro.dashboard.count, String(c.totals.transactionCount), "count"],
                      ] as const
                    ).map(([label, value, key]) => (
                      <div
                        key={key}
                        className="rounded-md bg-surface-2 px-4 py-3"
                        data-testid={`report-${key}`}
                      >
                        <dt className="text-sm text-muted-foreground">{label}</dt>
                        <dd className="font-mono text-lg font-semibold tabular-nums">{value}</dd>
                      </div>
                    ))}
                  </dl>

                  <h3 className="mt-5 mb-2 font-bold">{t.byCategory}</h3>
                  {c.byCategory.length === 0 ? (
                    <p className="text-muted-foreground">{ro.dashboard.byCategoryEmpty}</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-left text-sm">
                        <caption className="sr-only">
                          {t.byCategory} ({c.currency})
                        </caption>
                        <thead>
                          <tr className="border-b border-border">
                            <th scope="col" className="py-1.5 pr-3">
                              {ro.dashboard.tableCategory}
                            </th>
                            <th scope="col" className="py-1.5 pr-3 text-right">
                              {t.count}
                            </th>
                            <th scope="col" className="py-1.5 pr-3 text-right">
                              {t.amount}
                            </th>
                            <th scope="col" className="py-1.5 text-right">
                              {t.share}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.byCategory.flatMap((cat) => [
                            <tr
                              key={cat.categoryId ?? "none"}
                              className="border-b border-border font-semibold"
                            >
                              <th scope="row" className="py-1.5 pr-3">
                                {name(cat.name)}
                              </th>
                              <td className="py-1.5 pr-3 text-right tabular-nums">{cat.count}</td>
                              <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                                {formatMinor(cat.amountMinor, cur)}
                              </td>
                              <td className="py-1.5 text-right tabular-nums">{cat.percent}%</td>
                            </tr>,
                            ...(cat.children.length > 1 ||
                            (cat.children.length === 1 &&
                              cat.children[0]!.categoryId !== cat.categoryId)
                              ? cat.children.map((sub) => (
                                  <tr
                                    key={`${cat.categoryId ?? "none"}-${sub.categoryId ?? "none"}`}
                                    className="border-b border-border text-muted-foreground"
                                  >
                                    <th scope="row" className="py-1 pr-3 pl-4 font-normal">
                                      {sub.categoryId === cat.categoryId
                                        ? t.direct
                                        : name(sub.name)}
                                    </th>
                                    <td className="py-1 pr-3 text-right tabular-nums">
                                      {sub.count}
                                    </td>
                                    <td className="py-1 pr-3 text-right font-mono tabular-nums">
                                      {formatMinor(sub.amountMinor, cur)}
                                    </td>
                                    <td className="py-1" />
                                  </tr>
                                ))
                              : []),
                          ])}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <h3 className="mt-5 mb-2 font-bold">{t.topMerchants}</h3>
                  {c.topMerchants.length === 0 ? (
                    <p className="text-muted-foreground">{t.noMerchants}</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-left text-sm">
                        <caption className="sr-only">
                          {t.topMerchants} ({c.currency})
                        </caption>
                        <thead>
                          <tr className="border-b border-border">
                            <th scope="col" className="py-1.5 pr-3">
                              {t.merchant}
                            </th>
                            <th scope="col" className="py-1.5 pr-3 text-right">
                              {t.count}
                            </th>
                            <th scope="col" className="py-1.5 text-right">
                              {t.amount}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.topMerchants.map((m) => (
                            <tr key={m.merchant} className="border-b border-border">
                              <th scope="row" className="py-1.5 pr-3 font-normal">
                                {m.merchant}
                              </th>
                              <td className="py-1.5 pr-3 text-right tabular-nums">{m.count}</td>
                              <td className="py-1.5 text-right font-mono tabular-nums">
                                {formatMinor(m.amountMinor, cur)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
              );
            })
          : null}

        {result.ok ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card aria-labelledby="report-budgets">
              <CardHeader>
                <CardTitle id="report-budgets">{t.budgets}</CardTitle>
              </CardHeader>
              {result.value.report.budgets.length === 0 ? (
                <p className="text-muted-foreground">{ro.dashboard.budgetsEmpty}</p>
              ) : (
                <ul className="flex flex-col gap-4">
                  {result.value.report.budgets.map((b) => (
                    <li key={b.id}>
                      <BudgetLine
                        status={b}
                        name={budgetName(b, result.value.categoryName)}
                        href={`/budgets/${b.id}`}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card aria-labelledby="report-goals">
              <CardHeader>
                <CardTitle id="report-goals">{t.goals}</CardTitle>
              </CardHeader>
              {result.value.report.goals.length === 0 ? (
                <p className="text-muted-foreground">{ro.dashboard.goalsEmpty}</p>
              ) : (
                <ul className="flex flex-col gap-4">
                  {result.value.report.goals.map((g) => (
                    <li key={g.id}>
                      <GoalLine goal={g} href={`/goals/${g.id}`} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        ) : null}

        <Card aria-labelledby="report-exports">
          <CardHeader>
            <CardTitle id="report-exports">{t.exportsTitle}</CardTitle>
            <CardDescription>{t.exportsHint}</CardDescription>
          </CardHeader>
          <div className="flex flex-wrap gap-4">
            <ExportButton
              path={exportPath("transactions", { dateFrom: bounds.from, dateTo: bounds.to })}
              label={t.exportTransactions}
              filename="finet-tranzactii.csv"
              testId="report-export-transactions"
            />
            <ExportButton
              path={exportPath("budgets", { month: selection.month })}
              label={t.exportBudgets}
              filename="finet-bugete.csv"
              testId="report-export-budgets"
            />
            <ExportButton
              path={exportPath("goals")}
              label={t.exportGoals}
              filename="finet-obiective.csv"
              testId="report-export-goals"
            />
          </div>
        </Card>
      </div>
    </>
  );
}
