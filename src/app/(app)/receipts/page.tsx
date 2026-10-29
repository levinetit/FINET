import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { ro } from "@/messages/ro";
import { type ReceiptJson, receiptToJson } from "@/modules/receipts/receipts.schema";
import { listReceipts } from "@/modules/receipts/receipts.service";

import { formOptions } from "../../_lib/ledger-options";
import { asCurrency, formatCalendarDate } from "../../_lib/ledger-ui";
import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { formatTotal, receiptQueryOf, receiptStatusText } from "../../_lib/receipts-ui";
import { PageHeader } from "../page-header";

import { ReceiptRowActions } from "./receipt-row-actions";

export const metadata: Metadata = { title: ro.receipts.title };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Bonurile (F6-C, ADR 0015): „De verificat” mereu în partea de sus (interogare separată), apoi
 * istoricul cu căutarea după magazin, produs sau sumă („45,90” și „45.90”) și filtrele pe stare,
 * categorie și eticheta tranzacției. Formularul de căutare e un GET simplu (funcționează și fără
 * JavaScript); acțiunile pe rând (reprocesare, ștergere) trec prin `/api/v1/receipts/*`.
 */
export default async function ReceiptsPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const page = await requireLedgerPage("/receipts");
  const t = ro.receipts;
  const actions = (
    <div className="flex flex-wrap gap-2">
      <Link href="/import" className={buttonClasses()} data-testid="scan-button">
        {t.scan}
      </Link>
      <Link
        href="/receipts/matches"
        className={buttonClasses("outline")}
        data-testid="matches-link"
      >
        {ro.matching.title}
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
  const householdId = page.householdId;
  const { db, config } = page.session.runtime;
  const query = receiptQueryOf(await searchParams);
  const filtered = Object.keys(query).length > 0;
  const result = await load(async () => {
    const deps = { db, config };
    const [review, history, options] = await Promise.all([
      listReceipts(deps, page.actor, householdId, { status: "needs_review", limit: 100 }),
      listReceipts(deps, page.actor, householdId, { ...query, limit: 100 }),
      formOptions(db, page.actor, householdId),
    ]);
    return {
      review: review.data.map(receiptToJson),
      history: history.data.map(receiptToJson),
      more: history.nextCursor !== null,
      categories: options.categories.filter((c) => c.kind === "expense"),
      tags: options.tags,
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
  const { review, history, more, categories, tags } = result.value;
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  // „Istoricul” fără filtre nu repetă bonurile de verificat (sunt deja sus).
  const rows = filtered ? history : history.filter((r) => r.status !== "needs_review");

  return (
    <>
      {header}
      <div className="flex flex-col gap-4">
        <Card aria-labelledby="review-title" className="border-warn">
          <CardHeader>
            <CardTitle id="review-title">
              {t.toReview} ({review.length})
            </CardTitle>
          </CardHeader>
          {review.length === 0 ? (
            <p className="text-muted-foreground">{t.noReview}</p>
          ) : (
            <ReceiptTable rows={review} categoryName={categoryName} testId="review-list" />
          )}
        </Card>

        <Card aria-labelledby="history-title">
          <CardHeader>
            <CardTitle id="history-title">{t.history}</CardTitle>
          </CardHeader>
          <form method="get" className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-4" role="search">
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <Label htmlFor="receipts-q">{t.searchLabel}</Label>
              <Input
                id="receipts-q"
                name="q"
                defaultValue={query.q ?? ""}
                maxLength={100}
                aria-describedby="receipts-q-hint"
              />
              <p id="receipts-q-hint" className="text-xs text-muted-foreground">
                {t.searchHint}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="receipts-status">{t.statusFilter}</Label>
              <Select id="receipts-status" name="status" defaultValue={query.status ?? ""}>
                <option value="">{t.any}</option>
                {Object.entries(t.statuses).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="receipts-category">{t.categoryFilter}</Label>
              <Select
                id="receipts-category"
                name="categoryId"
                defaultValue={query.categoryId ?? ""}
              >
                <option value="">{t.any}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            {tags.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="receipts-tag">{t.tagFilter}</Label>
                <Select id="receipts-tag" name="tagId" defaultValue={query.tagId ?? ""}>
                  <option value="">{t.any}</option>
                  {tags.map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.name}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
            <div className="flex flex-wrap items-end gap-2 md:col-span-4">
              <button type="submit" className={buttonClasses("secondary")}>
                {t.search}
              </button>
              {filtered ? (
                <Link href="/receipts" className={buttonClasses("ghost")}>
                  {t.reset}
                </Link>
              ) : null}
            </div>
          </form>
          {rows.length === 0 ? (
            <p className="text-muted-foreground" data-testid="receipts-empty">
              {filtered ? t.emptyFiltered : t.empty}
            </p>
          ) : (
            <ReceiptTable rows={rows} categoryName={categoryName} testId="receipts-list" />
          )}
          {more ? <p className="mt-3 text-sm text-muted-foreground">{t.searchHint}</p> : null}
        </Card>
      </div>
    </>
  );
}

function ReceiptTable({
  rows,
  categoryName,
  testId,
}: Readonly<{
  rows: readonly ReceiptJson[];
  categoryName: ReadonlyMap<string, string>;
  testId: string;
}>) {
  const t = ro.receipts;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-left text-sm" data-testid={testId}>
        <thead className="text-muted-foreground">
          <tr>
            <th scope="col" className="py-2 pr-3 font-medium">
              {t.columns.date}
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              {t.columns.merchant}
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              {t.columns.categories}
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              {t.columns.total}
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              {t.columns.status}
            </th>
            <th scope="col" className="py-2 font-medium">
              <span className="sr-only">{t.columns.actions}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.id} data-testid="receipt-row" data-status={r.status}>
              <td className="py-2 pr-3 whitespace-nowrap">
                {r.occurredOn ? formatCalendarDate(r.occurredOn) : t.noDate}
              </td>
              <td className="py-2 pr-3">{r.merchantName ?? t.noMerchant}</td>
              <td className="py-2 pr-3">
                {r.categoryIds.length === 0
                  ? "—"
                  : r.categoryIds.map((id) => categoryName.get(id) ?? "—").join(", ")}
              </td>
              <td className="py-2 pr-3 text-right font-mono whitespace-nowrap tabular-nums">
                {formatTotal(r.totalMinor, asCurrency(r.currency))}
              </td>
              <td className="py-2 pr-3">
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-xs font-semibold",
                    r.status === "needs_review"
                      ? "bg-warn-soft"
                      : r.status === "saved"
                        ? "bg-ok-soft"
                        : "bg-muted",
                  )}
                >
                  {receiptStatusText(r.status)}
                </span>
              </td>
              <td className="py-2">
                <ReceiptRowActions id={r.id} saved={r.status === "saved"} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
