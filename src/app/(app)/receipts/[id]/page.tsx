import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { getStorage } from "@/lib/storage";
import { ro } from "@/messages/ro";
import { getDocumentWithReceipt } from "@/modules/documents/documents.service";
import { matchesToJson } from "@/app/api/v1/_lib/matching-handlers";
import { Card } from "@/components/ui/card";
import { getReceiptMatches } from "@/modules/matching/matching.service";
import { receiptDetailToJson } from "@/modules/receipts/receipts.schema";
import { getReceipt } from "@/modules/receipts/receipts.service";

import { formOptions } from "../../../_lib/ledger-options";
import { load, requireLedgerPage } from "../../../_lib/ledger-page";
import { PageHeader } from "../../page-header";

import { MatchPanel } from "../match-panel";

import { ReceiptReview, type ReviewDocument } from "./receipt-review";

export const metadata: Metadata = { title: ro.receipts.detailTitle };

type Params = Promise<{ id: string }>;

/**
 * Ecranul de verificare al unui bon (F6-C, ADR 0015): pozele (servite DOAR prin ruta autentificată
 * `/api/v1/documents/{id}/file`), câmpurile extrase editabile, liniile cu categoriile propuse,
 * problemele găsite de verificările din cod (cu câmpurile/liniile evidențiate), furnizorul AI și
 * motivul fallback-ului, liniile eliminate la unirea bonului lung, suma liniilor față de total,
 * bannerul „Posibil duplicat” și „Confirmă și salvează” (→ tranzacție). Un id străin → 404.
 */
export default async function ReceiptPage({ params }: Readonly<{ params: Params }>) {
  const { id } = await params;
  const page = await requireLedgerPage(`/receipts/${encodeURIComponent(id)}`);
  const t = ro.receipts;
  const back = (
    <Link href="/receipts" className={buttonClasses("ghost")}>
      {ro.ledger.back}
    </Link>
  );
  const header = (
    <PageHeader
      eyebrow={t.title}
      title={t.detailTitle}
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
  const { db, config } = page.session.runtime;
  const result = await load(async () => {
    const deps = { db, config, storage: getStorage() };
    const receipt = await getReceipt(deps, page.actor, householdId, id);
    const [options, docs, matches] = await Promise.all([
      formOptions(db, page.actor, householdId),
      Promise.all(
        receipt.documentIds.map((docId) =>
          getDocumentWithReceipt(deps, page.actor, householdId, docId),
        ),
      ),
      // F7-B: tranzacțiile din extras propuse (sub RLS: doar cele vizibile).
      getReceiptMatches({ db }, page.actor, householdId, id).catch(() => null),
    ]);
    const documents: ReviewDocument[] = docs.map((d) => ({
      id: d.id,
      mime: d.mime,
      fileDeleted: d.fileDeleted,
    }));
    return {
      matches: matches ? matchesToJson(matches) : null,
      receipt: receiptDetailToJson(receipt),
      documents,
      accounts: options.accounts,
      categories: options.categories
        .filter((c) => c.kind === "expense")
        .map((c) => ({ id: c.id, name: c.name })),
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
  const { matches, ...review } = result.value;
  return (
    <>
      {header}
      {matches ? (
        <Card className="mb-4">
          <MatchPanel
            receiptId={matches.receiptId}
            ambiguous={matches.ambiguous}
            candidates={matches.candidates}
          />
        </Card>
      ) : null}
      <ReceiptReview {...review} />
    </>
  );
}
