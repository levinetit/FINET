import type { Metadata } from "next";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";

import { Field } from "@/components/ledger/field";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { ValidationError } from "@/lib/errors";
import { ro } from "@/messages/ro";
import { accountToJson } from "@/modules/accounts/accounts.schema";
import { listAccounts } from "@/modules/accounts/accounts.service";
import { categoryToJson } from "@/modules/categories/categories.schema";
import { listCategories } from "@/modules/categories/categories.service";
import {
  type TransactionJson,
  transactionToJson,
} from "@/modules/transactions/transactions.schema";
import { listTransactions } from "@/modules/transactions/transactions.service";

import { load, requireLedgerPage } from "../../_lib/ledger-page";
import {
  apiSearch,
  FILTER_SORTS,
  FILTER_TYPES,
  hasActiveFilters,
  parseFilters,
} from "../../_lib/transaction-filters";
import { PageHeader } from "../page-header";

import { TransactionsList } from "./transactions-list";

export const metadata: Metadata = { title: ro.transactions.title };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Tranzacțiile: căutare și filtre (formular GET, deci adresa paginii poartă filtrele), sortare,
 * prima pagină citită pe server, „Încarcă mai mult” cu cursorul API-ului. Transferurile apar ca
 * transfer, nu ca venit sau cheltuială.
 */
export default async function TransactionsPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const page = await requireLedgerPage("/transactions");
  const filters = parseFilters(await searchParams);
  const actions = page.householdId ? (
    <>
      <Link href="/transactions/new?type=expense" className={buttonClasses()}>
        {ro.transactions.addExpense}
      </Link>
      <Link href="/transactions/new?type=income" className={buttonClasses("outline")}>
        {ro.transactions.addIncome}
      </Link>
      <Link href="/transfers/new" className={buttonClasses("outline")}>
        {ro.transactions.addTransfer}
      </Link>
    </>
  ) : null;
  const header = (
    <PageHeader
      eyebrow={ro.transactions.eyebrow}
      title={ro.transactions.title}
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
  const deps = { db: page.session.runtime.db };
  const lists = await load(async () => {
    const [accounts, categories] = await Promise.all([
      listAccounts(deps, page.actor, householdId, { includeArchived: true }),
      listCategories(deps, page.actor, householdId, { includeHidden: true }),
    ]);
    return {
      accounts: accounts.accounts.map(accountToJson),
      categories: categories.map(categoryToJson),
    };
  });
  if (!lists.ok) {
    return (
      <>
        {header}
        <Alert>{ro.ledger.loadError}</Alert>
      </>
    );
  }
  const { accounts, categories } = lists.value;

  // Filtrele invalide (de exemplu un interval inversat) dau o listă goală cu mesaj, nu o eroare.
  let rows: TransactionJson[] = [];
  let nextCursor: string | null = null;
  let filterError = Object.keys(filters.errors).length > 0;
  let loadError = false;
  if (!filterError) {
    try {
      const first = await listTransactions(deps, page.actor, householdId, filters.query);
      rows = first.data.map(transactionToJson);
      nextCursor = first.nextCursor;
    } catch (error) {
      unstable_rethrow(error);
      if (error instanceof ValidationError) filterError = true;
      else {
        console.error("[ui] tranzacțiile nu au putut fi încărcate");
        loadError = true;
      }
    }
  }
  const v = filters.values;
  const t = ro.transactions;

  return (
    <>
      {header}
      <div className="flex flex-col gap-4">
        <Card aria-labelledby="filters-title">
          <CardHeader>
            <CardTitle id="filters-title">{t.filters}</CardTitle>
          </CardHeader>
          <form method="get" action="/transactions" className="flex flex-col gap-4" role="search">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field id="filter-q" label={t.search} hint={t.searchHint}>
                {(p) => (
                  <Input
                    id={p.id}
                    name="q"
                    type="search"
                    defaultValue={v.q}
                    maxLength={200}
                    aria-describedby={p.describedBy}
                  />
                )}
              </Field>
              <Field id="filter-account" label={t.account}>
                {(p) => (
                  <Select id={p.id} name="accountId" defaultValue={filters.query.accountId ?? ""}>
                    <option value="">{t.allAccounts}</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field id="filter-category" label={t.category}>
                {(p) => (
                  <Select id={p.id} name="categoryId" defaultValue={filters.query.categoryId ?? ""}>
                    <option value="">{t.allCategories}</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({ro.ledger.types[c.kind] ?? c.kind})
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field id="filter-type" label={t.type}>
                {(p) => (
                  <Select id={p.id} name="type" defaultValue={filters.query.type ?? ""}>
                    <option value="">{t.allTypes}</option>
                    {FILTER_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {ro.ledger.types[type]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field id="filter-date-from" label={t.dateFrom}>
                {(p) => <Input id={p.id} name="dateFrom" type="date" defaultValue={v.dateFrom} />}
              </Field>
              <Field id="filter-date-to" label={t.dateTo}>
                {(p) => <Input id={p.id} name="dateTo" type="date" defaultValue={v.dateTo} />}
              </Field>
              <Field id="filter-amount-min" label={t.amountMin} error={filters.errors.amountMin}>
                {(p) => (
                  <Input
                    id={p.id}
                    name="amountMin"
                    inputMode="decimal"
                    defaultValue={v.amountMin}
                    aria-describedby={p.describedBy}
                    aria-invalid={p.invalid || undefined}
                  />
                )}
              </Field>
              <Field id="filter-amount-max" label={t.amountMax} error={filters.errors.amountMax}>
                {(p) => (
                  <Input
                    id={p.id}
                    name="amountMax"
                    inputMode="decimal"
                    defaultValue={v.amountMax}
                    aria-describedby={p.describedBy}
                    aria-invalid={p.invalid || undefined}
                  />
                )}
              </Field>
              <Field id="filter-sort" label={t.sort}>
                {(p) => (
                  <Select id={p.id} name="sort" defaultValue={filters.query.sort ?? "date_desc"}>
                    {FILTER_SORTS.map((s) => (
                      <option key={s} value={s}>
                        {t.sorts[s]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={buttonClasses("secondary")}>
                {t.apply}
              </button>
              <Link href="/transactions" className={buttonClasses("ghost")}>
                {t.reset}
              </Link>
            </div>
          </form>
        </Card>
        {filterError ? <Alert>{t.filterError}</Alert> : null}
        {loadError ? <Alert>{ro.ledger.loadError}</Alert> : null}
        {accounts.length === 0 ? (
          <Card>
            <p className="text-muted-foreground">{t.noAccounts}</p>
          </Card>
        ) : filterError || loadError ? null : (
          <TransactionsList
            // O interogare nouă (alte filtre) pornește lista de la zero.
            key={`${apiSearch(filters.query)}|${rows[0]?.id ?? ""}|${rows.length}`}
            initial={rows}
            initialCursor={nextCursor}
            query={filters.query}
            accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
            categories={categories.map((c) => ({ id: c.id, name: c.name }))}
            emptyText={hasActiveFilters(filters.query) ? t.emptyFiltered : t.empty}
          />
        )}
      </div>
    </>
  );
}
