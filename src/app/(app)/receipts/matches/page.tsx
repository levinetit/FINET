import type { Metadata } from "next";
import Link from "next/link";

import { matchesToJson } from "@/app/api/v1/_lib/matching-handlers";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardDescription } from "@/components/ui/card";
import type { Currency } from "@/lib/money";
import { ro } from "@/messages/ro";
import { listMatchQueue } from "@/modules/matching/matching.service";

import { formatMinor } from "../../../_lib/ledger-ui";
import { load, requireLedgerPage } from "../../../_lib/ledger-page";
import { formatDate } from "../../../_lib/planning-ui";
import { PageHeader } from "../../page-header";
import { MatchPanel } from "../match-panel";

export const metadata: Metadata = { title: ro.matching.title };

/** Coada potrivirilor bon ↔ tranzacție din extras (F7-B): bonurile cu cel puțin o propunere. */
export default async function MatchesPage() {
  const page = await requireLedgerPage("/receipts/matches");
  const t = ro.matching;
  const back = (
    <Link href="/receipts" className={buttonClasses("ghost")}>
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
  const result = await load(async () =>
    (await listMatchQueue({ db: page.session.runtime.db }, page.actor, hh, { limit: 20 })).map(
      matchesToJson,
    ),
  );
  if (!result.ok) {
    return (
      <>
        {header}
        <Alert>{ro.ledger.loadError}</Alert>
      </>
    );
  }
  return (
    <>
      {header}
      <div className="flex flex-col gap-4">
        <CardDescription>{t.hint}</CardDescription>
        {result.value.length === 0 ? (
          <Card>
            <p className="text-muted-foreground" data-testid="matches-empty">
              {t.empty}
            </p>
          </Card>
        ) : (
          result.value.map((m) => (
            <Card key={m.receiptId} data-testid="match-receipt">
              <p className="mb-2 text-sm">
                <Link
                  href={`/receipts/${m.receiptId}`}
                  className="font-semibold text-primary underline"
                >
                  {m.merchantName ?? t.viewReceipt}
                </Link>{" "}
                · {formatDate(m.occurredOn)} · {formatMinor(m.totalMinor, m.currency as Currency)}
              </p>
              <MatchPanel
                receiptId={m.receiptId}
                ambiguous={m.ambiguous}
                candidates={m.candidates}
              />
            </Card>
          ))
        )}
      </div>
    </>
  );
}
