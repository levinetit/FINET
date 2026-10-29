import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ro } from "@/messages/ro";
import { listAccounts } from "@/modules/accounts/accounts.service";
import { getStatementImport } from "@/modules/statements/statements.service";
import { importToJson } from "@/app/api/v1/_lib/statements-handlers";

import { formatMinor } from "../../../_lib/ledger-ui";
import { load, requireLedgerPage } from "../../../_lib/ledger-page";
import { formatDate } from "../../../_lib/planning-ui";
import { warningTexts } from "../../../_lib/statements-ui";
import { PageHeader } from "../../page-header";
import { StatementActions } from "../statement-actions";

import { ConfirmPanel } from "./confirm-panel";

export const metadata: Metadata = { title: ro.statements.preview };

type Params = Promise<{ id: string }>;

/**
 * Previzualizarea / detaliul unui import (F7-B): soldurile (verificate în cod), avertismentele,
 * tranzacțiile în așteptare ignorate, tabelul rândurilor cu duplicatele marcate, schimburile
 * valutare și confirmarea (cu `Idempotency-Key`). Un import invizibil (altă gospodărie, cont
 * personal al altui membru) → 404.
 */
export default async function StatementPage({ params }: Readonly<{ params: Params }>) {
  const { id } = await params;
  const page = await requireLedgerPage(`/statements/${encodeURIComponent(id)}`);
  const t = ro.statements;
  const back = (
    <Link href="/statements" className={buttonClasses("ghost")}>
      {ro.ledger.back}
    </Link>
  );
  const header = (
    <PageHeader eyebrow={t.title} title={t.preview} usageStats={page.usageStats} actions={back} />
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
  const deps = { db: page.session.runtime.db };
  const result = await load(async () => {
    const [imp, accounts] = await Promise.all([
      getStatementImport(deps, page.actor, hh, id),
      listAccounts(deps, page.actor, hh),
    ]);
    return {
      imp: importToJson(imp),
      accountName: accounts.accounts.find((a) => a.id === imp.accountId)?.name ?? "—",
      others: accounts.accounts
        .filter((a) => a.id !== imp.accountId && a.currency !== imp.currency)
        .map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
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
  const { imp, accountName, others } = result.value;
  const c = imp.currency;
  const lines = imp.lines ?? [];
  const money = (v: number | null) => (v === null ? "—" : formatMinor(v, c));
  return (
    <>
      {header}
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>
              {accountName} ·{" "}
              {imp.periodStart && imp.periodEnd
                ? t.period(formatDate(imp.periodStart), formatDate(imp.periodEnd))
                : t.noPeriod}
            </CardTitle>
          </CardHeader>
          <p className="text-sm" data-testid="statement-status">
            {t.statuses[imp.status]} · {imp.bank.toUpperCase()} · {imp.format.toUpperCase()} ·{" "}
            {t.counts(imp.lineCount, imp.newCount, imp.duplicateCount)}
          </p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt>{t.opening}</dt>
            <dd>{money(imp.openingBalanceMinor)}</dd>
            <dt>{t.closing}</dt>
            <dd>{money(imp.closingBalanceMinor)}</dd>
            <dt>{t.computed}</dt>
            <dd>{money(imp.computedClosingMinor)}</dd>
          </dl>
          <div className="mt-3 flex flex-col gap-2">
            {/* După confirmare pagina se reîncarcă de pe server (panoul de confirmare dispare):
                rezultatul stă aici, nu în starea clientului. */}
            {imp.status === "imported" ? (
              <Alert tone="ok" data-testid="statement-confirmed">
                {t.imported(imp.importedCount)}
              </Alert>
            ) : null}
            <Alert
              tone={imp.balanceStatus === "mismatch" ? "error" : "info"}
              data-testid="statement-balance"
              data-balance={imp.balanceStatus}
            >
              {imp.balanceStatus === "ok"
                ? t.balanceOk
                : imp.balanceStatus === "mismatch"
                  ? t.balanceMismatch
                  : t.balanceUnknown}
            </Alert>
            {imp.pendingCount > 0 ? (
              <Alert tone="info" data-testid="statement-pending">
                {t.pending(imp.pendingCount)}
              </Alert>
            ) : null}
            {warningTexts(imp.warnings.filter((w) => w !== "pending_skipped")).map((w) => (
              <Alert key={w} tone="info">
                {w}
              </Alert>
            ))}
          </div>
        </Card>
        {imp.status === "previewed" ? (
          <ConfirmPanel
            id={imp.id}
            currency={c}
            mismatch={imp.balanceStatus === "mismatch"}
            lines={lines.map((l) => ({
              rowNo: l.rowNo,
              occurredOn: l.occurredOn,
              direction: l.direction,
              amountMinor: l.amountMinor,
              description: l.description,
              kind: l.kind,
              fxCurrency: l.fxCurrency,
              fxAmountMinor: l.fxAmountMinor,
              state: l.state,
            }))}
            others={others}
          />
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm" data-testid="statement-lines">
                <caption className="sr-only">{t.table.caption}</caption>
                <thead>
                  <tr className="border-b border-border">
                    <th scope="col">{t.table.date}</th>
                    <th scope="col">{t.table.description}</th>
                    <th scope="col" className="text-right">
                      {t.table.amount}
                    </th>
                    <th scope="col">{t.table.state}</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.rowNo} className="border-b border-border" data-state={l.state}>
                      <td className="whitespace-nowrap">{formatDate(l.occurredOn)}</td>
                      <td>{l.description}</td>
                      <td
                        className={cn(
                          "text-right whitespace-nowrap",
                          l.direction === "credit" && "text-ok",
                        )}
                      >
                        {l.direction === "debit" ? "−" : "+"}
                        {formatMinor(l.amountMinor, c)}
                      </td>
                      <td>{t.lineStates[l.state]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3">
              <StatementActions id={imp.id} status={imp.status} />
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
