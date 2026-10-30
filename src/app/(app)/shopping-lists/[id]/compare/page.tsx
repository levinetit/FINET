import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { ConflictError } from "@/lib/errors";
import { isValidId } from "@/modules/ledger/input";
import { ro } from "@/messages/ro";
import {
  type ComparisonView,
  getComparison,
  listComparableReceipts,
} from "@/modules/shopping/compare.service";

import { load, requireLedgerPage } from "../../../../_lib/ledger-page";
import { formatDate } from "../../../../_lib/planning-ui";
import { displayQuantity } from "../../../../_lib/shopping-ui";
import { PageHeader } from "../../../page-header";

import { AiStatus } from "../../ai-poller";
import { CompareChooser } from "../../compare-chooser";
import { LinkToLine, MatchDecision } from "../../match-actions";

export const metadata: Metadata = { title: ro.shopping.compareTitle };

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ receipt?: string }>;

/**
 * Ecranul „Comparație cu bonul” (F10-A, ADR 0022): potrivite, neplanificate, uitate. Citirea e
 * fără scrieri (`GET`); propunerile se calculează la „Compară cu bonul”. Fiecare propunere se
 * confirmă, se respinge sau se corectează; nimic nu modifică bonul sau tranzacția. Pentru
 * accesibilitate, starea („nesigur”, „confirmat”) e text, nu doar culoare.
 */
export default async function ComparePage({
  params,
  searchParams,
}: Readonly<{ params: Params; searchParams: SearchParams }>) {
  const { id } = await params;
  const { receipt: rawReceipt } = await searchParams;
  const page = await requireLedgerPage(`/shopping-lists/${encodeURIComponent(id)}/compare`);
  const t = ro.shopping;
  const back = (
    <Link href={`/shopping-lists/${encodeURIComponent(id)}`} className={buttonClasses("ghost")}>
      {t.backToList}
    </Link>
  );
  const header = (
    <PageHeader
      eyebrow={t.eyebrow}
      title={t.compareTitle}
      usageStats={page.usageStats}
      actions={back}
    />
  );
  if (!page.householdId) {
    return (
      <>
        {header}
        <Alert>{ro.ledger.noHousehold}</Alert>
      </>
    );
  }
  const householdId = page.householdId;
  const deps = { db: page.session.runtime.db };
  const receiptId = rawReceipt && isValidId(rawReceipt) ? rawReceipt.toLowerCase() : null;
  const result = await load(async () => {
    const receipts = await listComparableReceipts(deps, page.actor, householdId);
    if (receiptId === null)
      return { receipts, view: null as ComparisonView | null, conflict: false };
    try {
      const { view } = await getComparison(deps, page.actor, householdId, id, receiptId);
      return { receipts, view, conflict: false };
    } catch (error) {
      if (error instanceof ConflictError) return { receipts, view: null, conflict: true };
      throw error;
    }
  });
  if (!result.ok) {
    return (
      <>
        {header}
        <Alert>{ro.ledger.loadError}</Alert>
      </>
    );
  }
  const { receipts, view, conflict } = result.value;
  const options = receipts.map((r) => ({
    id: r.id,
    label: t.receiptLabel(r.merchantName ?? "", r.occurredOn ? formatDate(r.occurredOn) : ""),
  }));
  const chooser = (
    <Card aria-labelledby="chooser-title">
      <CardHeader>
        <CardTitle id="chooser-title">{view ? t.refresh : t.compareTitle}</CardTitle>
        <p className="text-sm text-muted-foreground">{t.compareIntro}</p>
      </CardHeader>
      <CompareChooser
        mode="receipt"
        fixedId={id}
        options={options}
        initialId={view?.receipt.id ?? receiptId ?? undefined}
      />
    </Card>
  );
  if (!view) {
    return (
      <>
        {header}
        {conflict ? (
          <Alert className="mb-4" data-testid="receipt-not-confirmed">
            {t.receiptNotConfirmed}
          </Alert>
        ) : null}
        {chooser}
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow={`${view.list.name} ↔ ${t.receiptLabel(
          view.receipt.merchantName ?? "",
          view.receipt.occurredOn ? formatDate(view.receipt.occurredOn) : "",
        )}`}
        title={t.compareTitle}
        usageStats={page.usageStats}
        actions={
          <>
            {back}
            <Link href={`/receipts/${view.receipt.id}`} className={buttonClasses("outline")}>
              {t.openReceipt}
            </Link>
          </>
        }
      />
      <div className="flex flex-col gap-4" data-testid="comparison">
        <AiStatus status={view.ai.status} />

        <Card aria-labelledby="matched-title">
          <CardHeader>
            <CardTitle id="matched-title">
              {t.matchedTitle} ({view.matched.length})
            </CardTitle>
          </CardHeader>
          {view.matched.length === 0 ? (
            <p className="text-muted-foreground">{t.matchedEmpty}</p>
          ) : (
            <ul className="flex flex-col gap-3" data-testid="matched">
              {view.matched.map((m) => (
                <li
                  key={m.item.id}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border p-3"
                  data-testid="matched-item"
                  data-status={m.status}
                >
                  <div className="flex min-w-0 flex-col gap-1 text-sm">
                    <span className="font-semibold break-words">
                      {m.item.name}{" "}
                      <span className="font-normal text-muted-foreground">
                        ({t.listQuantity(displayQuantity(m.item.quantity))})
                      </span>
                    </span>
                    <span className="break-words">
                      ↔ {m.line.name}
                      {m.line.quantity
                        ? ` (${t.lineQuantity(displayQuantity(m.line.quantity))})`
                        : ""}
                    </span>
                    <span className="text-muted-foreground">
                      {m.status === "confirmed" ? t.confirmed : t.suggested}
                      {m.uncertain ? ` · ${t.uncertain}` : ""}
                      {m.score !== null ? ` · ${t.score(m.score)}` : ""} ·{" "}
                      {t.source[m.source] ?? ""}
                    </span>
                  </div>
                  <MatchDecision
                    listId={view.list.id}
                    itemId={m.item.id}
                    itemName={m.item.name}
                    confirmed={m.status === "confirmed"}
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card aria-labelledby="unplanned-title">
          <CardHeader>
            <CardTitle id="unplanned-title">
              {t.unplannedTitle} ({view.unplanned.length})
            </CardTitle>
            <p className="text-sm text-muted-foreground">{t.unplannedHint}</p>
          </CardHeader>
          {view.unplanned.length === 0 ? (
            <p className="text-muted-foreground">{t.unplannedEmpty}</p>
          ) : (
            <ul className="flex list-disc flex-col gap-1 pl-5" data-testid="unplanned">
              {view.unplanned.map((l) => (
                <li key={l.id} data-testid="unplanned-line">
                  {l.name}
                  {l.quantity ? ` (${t.lineQuantity(displayQuantity(l.quantity))})` : ""}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card aria-labelledby="forgotten-title">
          <CardHeader>
            <CardTitle id="forgotten-title">
              {t.forgottenTitle} ({view.forgotten.length})
            </CardTitle>
            <p className="text-sm text-muted-foreground">{t.forgottenHint}</p>
          </CardHeader>
          {view.forgotten.length === 0 ? (
            <p className="text-muted-foreground">{t.forgottenEmpty}</p>
          ) : (
            <ul className="flex flex-col gap-3" data-testid="forgotten">
              {view.forgotten.map((i) => (
                <li
                  key={i.id}
                  className="flex flex-wrap items-center justify-between gap-3"
                  data-testid="forgotten-item"
                >
                  <span className="break-words">{i.name}</span>
                  <LinkToLine
                    listId={view.list.id}
                    itemId={i.id}
                    itemName={i.name}
                    lines={view.unplanned}
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>

        {view.checkedMissing.length > 0 ? (
          <Card aria-labelledby="missing-title">
            <CardHeader>
              <CardTitle id="missing-title">
                {t.checkedMissingTitle} ({view.checkedMissing.length})
              </CardTitle>
              <p className="text-sm text-muted-foreground">{t.checkedMissingHint}</p>
            </CardHeader>
            <ul className="flex flex-col gap-3" data-testid="checked-missing">
              {view.checkedMissing.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-3">
                  <span className="break-words">{i.name}</span>
                  <LinkToLine
                    listId={view.list.id}
                    itemId={i.id}
                    itemName={i.name}
                    lines={view.unplanned}
                  />
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {view.boughtElsewhere.length > 0 ? (
          <Card aria-labelledby="elsewhere-title">
            <CardHeader>
              <CardTitle id="elsewhere-title">
                {t.boughtElsewhereTitle} ({view.boughtElsewhere.length})
              </CardTitle>
            </CardHeader>
            <ul className="flex list-disc flex-col gap-1 pl-5" data-testid="bought-elsewhere">
              {view.boughtElsewhere.map((i) => (
                <li key={i.id}>{i.name}</li>
              ))}
            </ul>
          </Card>
        ) : null}

        {chooser}
      </div>
    </>
  );
}
