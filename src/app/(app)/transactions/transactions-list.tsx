"use client";

import Link from "next/link";
import { useState } from "react";

import { TagChip } from "@/components/planning/tag-chip";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ro } from "@/messages/ro";
import type { TransactionJson } from "@/modules/transactions/transactions.schema";

import { apiFetch, goToLogin } from "../../_lib/api-client";
import { formatCalendarDate, formatMinor, formatSigned } from "../../_lib/ledger-ui";
import { type TransactionApiQuery, apiSearch, appendUnique } from "../../_lib/transaction-filters";
import { useHydrated } from "../../_lib/use-hydrated";

type Named = Readonly<{ id: string; name: string }>;

/** Un rând al listei: tranzacția în forma API-ului, cu etichetele ei (Faza 3). */
export type TransactionRow = TransactionJson & {
  tags: ReadonlyArray<Readonly<{ id: string; name: string; color: string | null }>>;
};

/**
 * Lista tranzacțiilor: prima pagină vine de la server; „Încarcă mai mult” cere pagina următoare
 * (`GET /api/v1/transactions?…&cursor=`) cu ACEEAȘI interogare, iar rândurile se adaugă fără
 * duplicate.
 */
export function TransactionsList({
  initial,
  initialCursor,
  query,
  accounts,
  categories,
  emptyText,
}: Readonly<{
  initial: readonly TransactionRow[];
  initialCursor: string | null;
  query: TransactionApiQuery;
  accounts: readonly Named[];
  categories: readonly Named[];
  emptyText: string;
}>) {
  const [rows, setRows] = useState<TransactionRow[]>([...initial]);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hydrated = useHydrated();
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    const result = await apiFetch<TransactionRow[]>(
      `/api/v1/transactions${apiSearch(query, cursor)}`,
      { method: "GET" },
    );
    setLoading(false);
    if (result.status === 401) return goToLogin();
    const raw = result.raw as { data?: TransactionRow[]; nextCursor?: string | null } | null;
    if (!result.ok || !raw || !Array.isArray(raw.data)) {
      setError(ro.transactions.loadMoreError);
      return;
    }
    setRows((current) => appendUnique(current, raw.data ?? []));
    setCursor(raw.nextCursor ?? null);
  }

  if (rows.length === 0) {
    return (
      <Card>
        <p className="text-muted-foreground" data-testid="transactions-empty">
          {emptyText}
        </p>
      </Card>
    );
  }

  return (
    <Card aria-label={ro.transactions.title}>
      <p className="sr-only" aria-live="polite">
        {ro.transactions.count(rows.length)}
      </p>
      <ul className="flex flex-col divide-y divide-border" data-testid="transactions-list">
        {rows.map((r) => {
          const isTransfer = r.type === "transfer";
          const title =
            r.description ??
            r.merchant ??
            (isTransfer
              ? r.transferDirection === "out"
                ? ro.transactions.transferOut
                : ro.transactions.transferIn
              : ro.ledger.types[r.type]);
          return (
            <li key={r.id} data-testid="transaction-row" data-type={r.type}>
              <Link
                href={`/transactions/${r.id}`}
                className="flex items-center justify-between gap-3 py-3 hover:text-primary"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-semibold">{title}</span>
                    {isTransfer ? (
                      <span
                        className="rounded bg-accent-soft px-1.5 py-0.5 text-xs font-semibold"
                        data-testid="transfer-badge"
                      >
                        {ro.transactions.transferBadge}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {formatCalendarDate(r.occurredOn)} · {accountName.get(r.accountId) ?? "—"}
                    {isTransfer
                      ? ` · ${r.transferDirection === "out" ? ro.transactions.transferOut : ro.transactions.transferIn}`
                      : ` · ${r.categoryId ? (categoryName.get(r.categoryId) ?? "—") : ro.transactions.noCategory}`}
                  </span>
                  {r.tags && r.tags.length > 0 ? (
                    <span className="mt-1 flex flex-wrap gap-1" data-testid="transaction-tags">
                      {r.tags.map((tag) => (
                        <TagChip key={tag.id} name={tag.name} color={tag.color} />
                      ))}
                    </span>
                  ) : null}
                </span>
                <span
                  className={
                    "font-mono font-semibold whitespace-nowrap tabular-nums " +
                    (r.type === "expense" ? "text-bad" : r.type === "income" ? "text-ok" : "")
                  }
                  data-testid="transaction-amount"
                >
                  {isTransfer
                    ? formatMinor(r.amountMinor, r.currency)
                    : formatSigned(r.type, r.amountMinor, r.currency)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <Alert className="mt-3">{error}</Alert>
      {cursor ? (
        <div className="mt-3">
          <Button variant="outline" onClick={() => void loadMore()} disabled={loading || !hydrated}>
            {loading ? ro.transactions.loadingMore : ro.transactions.loadMore}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
