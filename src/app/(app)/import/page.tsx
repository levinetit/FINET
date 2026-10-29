import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getStorage } from "@/lib/storage";
import { ro } from "@/messages/ro";
import { listAccounts } from "@/modules/accounts/accounts.service";
import { dailyUsage, listDocuments } from "@/modules/documents/documents.service";
import { getConsents } from "@/modules/usage/consents";

import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { PageHeader } from "../page-header";

import { type RecentDocument, ImportClient } from "./import-client";
import { StatementImport } from "./statement-import";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Filele „Bon fiscal” / „Extras bancar” (linkuri: funcționează și fără JavaScript). */
function Tabs({ statement }: Readonly<{ statement: boolean }>) {
  const t = ro.imports.tabs;
  return (
    <nav aria-label={t.label} className="mb-4">
      <ul className="flex flex-wrap gap-2">
        {(
          [
            ["/import", t.receipt, !statement],
            ["/import?tip=extras", t.statement, statement],
          ] as const
        ).map(([href, label, current]) => (
          <li key={href}>
            <Link
              href={href}
              aria-current={current ? "page" : undefined}
              className={buttonClasses(current ? "secondary" : "ghost")}
              data-testid={current ? "import-tab-current" : undefined}
            >
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

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
export default async function ImportPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const page = await requireLedgerPage("/import");
  const t = ro.imports;
  const statement = (await searchParams).tip === "extras";
  const header = (
    <>
      <PageHeader
        eyebrow={statement ? ro.statements.eyebrow : t.eyebrow}
        title={t.title}
        usageStats={page.usageStats}
      />
      <Tabs statement={statement} />
    </>
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
  const { db, config } = page.session.runtime;
  if (statement) {
    // Extrasele (F7-B): conturile vizibile și deschise (un cont personal al altui membru nu apare).
    const accounts = await load(async () =>
      (await listAccounts({ db }, page.actor, householdId)).accounts
        .filter((a) => a.type !== "cash")
        .map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
    );
    return (
      <>
        {header}
        {accounts.ok ? (
          <StatementImport accounts={accounts.value} />
        ) : (
          <Alert>{ro.ledger.loadError}</Alert>
        )}
        <p className="mt-4 flex flex-wrap gap-3 text-sm">
          <Link href="/statements" className="font-semibold text-primary underline">
            {ro.statements.list}
          </Link>
          <Link href="/statements/coverage" className="font-semibold text-primary underline">
            {ro.statements.coverage}
          </Link>
        </p>
      </>
    );
  }
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
