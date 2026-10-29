import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { ro } from "@/messages/ro";
import { listComparableReceipts } from "@/modules/shopping/compare.service";
import { itemToJson, listToJson } from "@/modules/shopping/shopping.schema";
import { getList, suggestProducts } from "@/modules/shopping/shopping.service";

import { load, requireLedgerPage } from "../../../_lib/ledger-page";
import { formatDate } from "../../../_lib/planning-ui";
import { PageHeader } from "../../page-header";

import { CompareChooser } from "../compare-chooser";
import { ListActions } from "../list-actions";
import { ShoppingList } from "../shopping-list";

export const metadata: Metadata = { title: ro.shopping.detailTitle };

type Params = Promise<{ id: string }>;

/**
 * O listă de cumpărături (F10-A): articolele cu bifare la raft, adăugare rapidă cu sugestii din
 * produsele frecvente ale gospodăriei (nume normalizate calculate în SQL), comparația cu un bon
 * confirmat și acțiunile pe listă. Un id străin sau al unei liste personale a altui membru → 404.
 */
export default async function ShoppingListPage({ params }: Readonly<{ params: Params }>) {
  const { id } = await params;
  const page = await requireLedgerPage(`/shopping-lists/${encodeURIComponent(id)}`);
  const t = ro.shopping;
  const back = (
    <Link href="/shopping-lists" className={buttonClasses("ghost")}>
      {ro.ledger.back}
    </Link>
  );
  if (!page.householdId) {
    return (
      <>
        <PageHeader eyebrow={t.eyebrow} title={t.detailTitle} actions={back} />
        <Alert>{ro.ledger.noHousehold}</Alert>
      </>
    );
  }
  const householdId = page.householdId;
  const deps = { db: page.session.runtime.db };
  const result = await load(async () => {
    const detail = await getList(deps, page.actor, householdId, id);
    const [suggestions, receipts] = await Promise.all([
      suggestProducts(deps, page.actor, householdId).catch(() => []),
      listComparableReceipts(deps, page.actor, householdId).catch(() => []),
    ]);
    return {
      list: listToJson(detail.list),
      items: detail.items.map(itemToJson),
      suggestions: suggestions.map((s) => s.name),
      receipts: receipts.map((r) => ({
        id: r.id,
        label: t.receiptLabel(r.merchantName ?? "", r.occurredOn ? formatDate(r.occurredOn) : ""),
      })),
    };
  });
  if (!result.ok) {
    return (
      <>
        <PageHeader eyebrow={t.eyebrow} title={t.detailTitle} actions={back} />
        <Alert>{ro.ledger.loadError}</Alert>
      </>
    );
  }
  const { list, items, suggestions, receipts } = result.value;
  return (
    <>
      <PageHeader
        eyebrow={`${list.shared ? t.sharedBadge : t.personalBadge}${
          list.status === "archived" ? ` · ${t.archivedBadge}` : ""
        }`}
        title={list.name}
        usageStats={page.usageStats}
        actions={back}
      />
      <div className="flex flex-col gap-4">
        <Card aria-labelledby="items-title">
          <CardHeader>
            <CardTitle id="items-title">{t.items}</CardTitle>
          </CardHeader>
          <ShoppingList
            listId={list.id}
            initialItems={items}
            suggestions={suggestions}
            readOnly={list.status === "archived"}
          />
        </Card>
        <Card aria-labelledby="compare-title">
          <CardHeader>
            <CardTitle id="compare-title">{t.compareTitle}</CardTitle>
            <p className="text-sm text-muted-foreground">{t.compareIntro}</p>
          </CardHeader>
          <CompareChooser mode="receipt" fixedId={list.id} options={receipts} />
        </Card>
        <Card aria-labelledby="actions-title">
          <CardHeader>
            <CardTitle id="actions-title">{t.listMenu}</CardTitle>
          </CardHeader>
          <ListActions list={list} />
        </Card>
      </div>
    </>
  );
}
