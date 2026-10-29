import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardDescription } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ro } from "@/messages/ro";
import { getStatementCoverage } from "@/modules/statements/statements.service";

import { todayIn } from "../../../_lib/ledger-ui";
import { load, requireLedgerPage } from "../../../_lib/ledger-page";
import { coverageLabel, formatMonth, lastMonths } from "../../../_lib/statements-ui";
import { PageHeader } from "../../page-header";

export const metadata: Metadata = { title: ro.coverage.title };

const MONTHS = 12;

/**
 * „Acoperire extrase” (master prompt Faza 7; F7-B): conturile vizibile × ultimele 12 luni, cu
 * starea complet / parțial (până la ce dată) / lipsă și avertizarea pentru lunile fără extras după
 * primul import. Text în fiecare celulă (nu doar culoare), tabel cu antete pentru cititoare.
 */
export default async function CoveragePage() {
  const page = await requireLedgerPage("/statements/coverage");
  const t = ro.coverage;
  const back = (
    <Link href="/statements" className={buttonClasses("ghost")}>
      {ro.ledger.back}
    </Link>
  );
  const header = (
    <PageHeader eyebrow={t.eyebrow} title={t.title} usageStats={page.usageStats} actions={back} />
  );
  if (!page.householdId) {
    return (
      <>
        {header}
        <Alert>{ro.ledger.noHousehold}</Alert>
      </>
    );
  }
  const hh = page.householdId;
  const range = lastMonths(todayIn(), MONTHS);
  const result = await load(() =>
    getStatementCoverage({ db: page.session.runtime.db }, page.actor, hh, range),
  );
  if (!result.ok) {
    return (
      <>
        {header}
        <Alert>{ro.ledger.loadError}</Alert>
      </>
    );
  }
  const rows = result.value;
  const months = rows[0]?.months.map((m) => m.month) ?? [];
  return (
    <>
      {header}
      <div className="flex flex-col gap-4">
        {rows
          .filter((r) => r.missingMonths.length)
          .map((r) => (
            <Alert key={r.accountId} tone="info" data-testid="coverage-missing">
              {t.missingWarning(r.accountName, r.missingMonths.map(formatMonth).join(", "))}
            </Alert>
          ))}
        <Card>
          <CardDescription>{t.hint}</CardDescription>
          {rows.length === 0 ? (
            <p className="mt-3 text-muted-foreground">{t.empty}</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-xs" data-testid="coverage-table">
                <caption className="sr-only">{t.caption}</caption>
                <thead>
                  <tr className="border-b border-border">
                    <th scope="col">{t.account}</th>
                    {months.map((m) => (
                      <th key={m} scope="col" className="px-1 whitespace-nowrap">
                        {formatMonth(m)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.accountId} className="border-b border-border" data-testid="coverage-row">
                      <th scope="row" className="pr-2 font-semibold whitespace-nowrap">
                        {r.accountName}
                      </th>
                      {r.months.map((c) => (
                        <td
                          key={c.month}
                          data-status={c.status}
                          className={cn(
                            "px-1 py-1",
                            c.status === "complete" && "bg-ok-soft",
                            c.status === "partial" && "bg-warn-soft",
                          )}
                        >
                          {coverageLabel(c)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
