import type { Metadata } from "next";

import { Card } from "@/components/ui/card";
import { ro } from "@/messages/ro";

import { requireLedgerPage } from "../../_lib/ledger-page";
import { PageHeader } from "../page-header";

import { AskForm } from "./ask-form";

export const metadata: Metadata = { title: ro.ask.title };

/**
 * „Întreabă FINET” (F10-C, ADR 0025): o întrebare în română, transformată în cod într-o
 * interogare dintr-un set închis; cifrele vin din baza de date, iar răspunsul arată interogarea.
 * Fără AI și fără date trimise în afara aplicației.
 */
export default async function AskPage() {
  const page = await requireLedgerPage("/ask");
  const t = ro.ask;
  const header = <PageHeader eyebrow={t.eyebrow} title={t.title} usageStats={page.usageStats} />;
  if (!page.householdId) {
    return (
      <>
        {header}
        <Card>
          <p className="text-muted-foreground">{t.noHousehold}</p>
        </Card>
      </>
    );
  }
  return (
    <>
      {header}
      <p className="mb-4 text-muted-foreground">{t.intro}</p>
      <AskForm />
    </>
  );
}
