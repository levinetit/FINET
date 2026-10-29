import type { Metadata } from "next";

import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { getStorage } from "@/lib/storage";
import { ro } from "@/messages/ro";
import { dailyUsage, listDocuments } from "@/modules/documents/documents.service";
import { getConsents } from "@/modules/usage/consents";

import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { PageHeader } from "../page-header";

import { type RecentDocument, ImportClient } from "./import-client";

export const metadata: Metadata = { title: ro.imports.title };

/** Momentul de acum 24 de ore (lista „Încărcate recent”). */
function dayAgo(): string {
  return new Date(Date.now() - 24 * 3600 * 1000).toISOString();
}

/**
 * Importul bonurilor (F6-C, ADR 0015): o singură zonă de încărcare (alegere sau drag & drop),
 * contorul zilei, modul explicit „bon lung (2–4 poze)” cu ordinea de sus în jos (reordonare cu
 * butoane), mesajul pentru consimțământul `externalAi` lipsă (link la Profil) și starea fiecărui
 * document (`queued` → `processing` → `needs_review`), cu polling blând. Datele inițiale vin de pe
 * server (documentele din ultimele 24 de ore), restul prin `/api/v1/documents`.
 */
export default async function ImportPage() {
  const page = await requireLedgerPage("/import");
  const t = ro.imports;
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
  const { db, config } = page.session.runtime;
  const result = await load(async () => {
    const since = dayAgo();
    const deps = { db, config, storage: getStorage() };
    const [usage, docs, consents] = await Promise.all([
      dailyUsage(deps, page.actor, householdId),
      listDocuments(deps, page.actor, householdId, { since, limit: 20 }),
      getConsents(db, page.actor.userId),
    ]);
    const recent: RecentDocument[] = docs.map((d) => ({
      id: d.id,
      status: d.status,
      errorCode: d.errorCode,
      receiptId: d.receiptId,
      batchId: d.batchId,
      documentOrder: d.documentOrder,
      createdAt: d.createdAt.toISOString(),
    }));
    return {
      usage,
      recent,
      externalAi: consents.some((c) => c.kind === "externalAi" && c.granted),
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
  return (
    <>
      {header}
      <ImportClient
        initialUsage={result.value.usage}
        initialRecent={result.value.recent}
        externalAi={result.value.externalAi}
        maxUploadBytes={config.documents.maxUploadBytes}
      />
    </>
  );
}
