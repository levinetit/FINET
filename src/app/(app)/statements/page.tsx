import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { ro } from "@/messages/ro";
import { listAccounts } from "@/modules/accounts/accounts.service";
import { listStatementImports } from "@/modules/statements/statements.service";
import { listStatementUploads } from "@/modules/statements/uploads.service";

import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { formatDate } from "../../_lib/planning-ui";
import { statementErrorText } from "../../_lib/statements-ui";
import { PageHeader } from "../page-header";

import { StatementActions } from "./statement-actions";

export const metadata: Metadata = { title: ro.statements.title };

/**
 * Lista importurilor de extrase (F7-B): perioada, contul, starea, contoarele și anularea (cu
 * decizia explicită pentru tranzacțiile modificate); extrasele PDF încă în lucru. Doar ce vede
 * membrul: importurile pe conturile personale ale altor membri nu apar (RLS).
 */
export default async function StatementsPage() {
  const page = await requireLedgerPage("/statements");
  const t = ro.statements;
  const actions = (
    <div className="flex flex-wrap gap-2">
      <Link href="/import?tip=extras" className={buttonClasses()}>
        {t.importTitle}
      </Link>
      <Link href="/statements/coverage" className={buttonClasses("outline")}>
        {t.coverage}
      </Link>
    </div>
  );
  const header = (
    <PageHeader
      eyebrow={t.eyebrow}
      title={t.title}
      usageStats={page.usageStats}
      actions={actions}
    />
  );
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
  const hh = page.householdId;
  const deps = { db: page.session.runtime.db };
  const result = await load(async () => {
    const [imports, uploads, accounts] = await Promise.all([
      listStatementImports(deps, page.actor, hh, { limit: 100 }),
      listStatementUploads(deps, page.actor, hh),
      listAccounts(deps, page.actor, hh, { includeArchived: true }),
    ]);
    return {
      imports,
      uploads: uploads.filter((u) => u.status !== "parsed" && !u.fileDeleted),
      accountName: new Map(accounts.accounts.map((a) => [a.id, a.name])),
    };
  });
  if (!result.ok) {
    return (
      <>
        {header}
        <Alert>{ro.ledger.loadError}</Alert>
      </>
    );
  }
  const { imports, uploads, accountName } = result.value;
  return (
    <>
      {header}
      <div className="flex flex-col gap-4">
        {uploads.length ? (
          <Card>
            <CardHeader>
              <CardTitle>{t.uploads}</CardTitle>
            </CardHeader>
            <ul className="flex flex-col gap-1 text-sm" data-testid="statement-uploads">
              {uploads.map((u) => (
                <li key={u.id}>
                  {accountName.get(u.accountId) ?? "—"} · {t.uploadStatuses[u.status]}
                  {u.status === "failed" ? ` · ${statementErrorText(u.errorCode)}` : ""}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>{t.list}</CardTitle>
          </CardHeader>
          {imports.length === 0 ? (
            <p className="text-muted-foreground" data-testid="statements-empty">
              {t.noImports}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border" data-testid="statements-list">
              {imports.map((i) => (
                <li
                  key={i.id}
                  className="flex flex-wrap items-start justify-between gap-3 py-3"
                  data-testid="statement-row"
                  data-status={i.status}
                >
                  <div className="flex flex-col gap-1">
                    <Link href={`/statements/${i.id}`} className="font-semibold hover:text-primary">
                      {accountName.get(i.accountId) ?? "—"} ·{" "}
                      {i.periodStart && i.periodEnd
                        ? t.period(formatDate(i.periodStart), formatDate(i.periodEnd))
                        : t.noPeriod}
                    </Link>
                    <span className="text-sm text-muted-foreground">
                      {t.statuses[i.status]} · {i.bank.toUpperCase()} · {i.format.toUpperCase()} ·{" "}
                      {t.counts(i.lineCount, i.newCount, i.duplicateCount)}
                    </span>
                  </div>
                  <StatementActions id={i.id} status={i.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
