import type { Metadata } from "next";

import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { ro } from "@/messages/ro";
import { tagToJson } from "@/modules/tags/tags.schema";
import { listTags } from "@/modules/tags/tags.service";

import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { PageHeader } from "../page-header";

import { TagsManager } from "./tags-manager";

export const metadata: Metadata = { title: ro.tags.title };

/** Etichetele (5.4): pagină separată de categorii (ADR 0008), cu cele ascunse incluse. */
export default async function TagsPage() {
  const page = await requireLedgerPage("/tags");
  const header = (
    <PageHeader eyebrow={ro.tags.eyebrow} title={ro.tags.title} usageStats={page.usageStats} />
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
  const householdId = page.householdId;
  const result = await load(() =>
    listTags({ db: page.session.runtime.db }, page.actor, householdId, { includeHidden: true }),
  );
  return (
    <>
      {header}
      {result.ok ? (
        <TagsManager tags={result.value.map(tagToJson)} />
      ) : (
        <Alert>{ro.ledger.loadError}</Alert>
      )}
    </>
  );
}
