import type { Metadata } from "next";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";

import { Field } from "@/components/ledger/field";
import { ExportButton } from "@/components/planning/export-button";
import { TagDot } from "@/components/planning/tag-chip";
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
import { tagToJson } from "@/modules/tags/tags.schema";
import { listTags, transactionTagRefs } from "@/modules/tags/tags.service";
import { transactionToJson } from "@/modules/transactions/transactions.schema";
import { listTransactions } from "@/modules/transactions/transactions.service";

import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { exportPath } from "../../_lib/planning-ui";
import {
  apiSearch,
  exportSearch,
  FILTER_SORTS,
  FILTER_TYPES,
  hasActiveFilters,
  parseFilters,
} from "../../_lib/transaction-filters";
import { PageHeader } from "../page-header";

import { type TransactionRow, TransactionsList } from "./transactions-list";

export const metadata: Metadata = { title: ro.transactions.title };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Tranzacțiile: căutare și filtre (formular GET, deci adresa paginii poartă filtrele), sortare,
 * prima pagină citită pe server, „Încarcă mai mult” cu cursorul API-ului. Transferurile apar ca
 * transfer, nu ca venit sau cheltuială. Faza 3: filtrele „comerciant” și „etichete” (oricare),
 * etichetele pe rânduri și „Export CSV” cu aceleași filtre (fără ordine: exportul e cronologic).
 * În URL stau id-uri, date, sume și tipul; textul liber (`q`, `merchant`) stă și el acolo, ca o
 * vedere să se poată salva (ADR 0008, LOW-3 în SECURITY_CHECKLIST).
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
    const [accounts, categories, tags] = await Promise.all([
      listAccounts(deps, page.actor, householdId, { includeArchived: true }),
      listCategories(deps, page.actor, householdId, { includeHidden: true }),
      listTags(deps, page.actor, householdId, { includeHidden: true }),
    ]);
    return {
      accounts: accounts.accounts.map(accountToJson),
      categories: categories.map(categoryToJson),
      tags: tags.map(tagToJson),
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
  const selectedTags = new Set(filters.values.tagIds);
  // Etichetele ascunse nu se propun, dar una deja aleasă în filtru rămâne bifabilă.
  const tagOptions = lists.value.tags.filter((tag) => !tag.hidden || selectedTags.has(tag.id));

  // Filtrele invalide (de exemplu un interval inversat) dau o listă goală cu mesaj, nu o eroare.
  let rows: TransactionRow[] = [];
  let nextCursor: string | null = null;
  let filterError = Object.keys(filters.errors).length > 0;
  let loadError = false;
  if (!filterError) {
    try {
      const first = await listTransactions(deps, page.actor, householdId, filters.query);
      // Etichetele rândurilor, ca în API (o singură interogare pe pagină).
      const refs = await transactionTagRefs(
        deps,
        page.actor,
        householdId,
        first.data.filter((r) => r.type !== "transfer").map((r) => r.id),
      );
      rows = first.data.map((r) => ({ ...transactionToJson(r), tags: refs.get(r.id) ?? [] }));
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
              <Field id="filter-merchant" label={t.merchantFilter} hint={t.merchantFilterHint}>
                {(p) => (
                  <Input
                    id={p.id}
                    name="merchant"
                    defaultValue={v.merchant}
                    maxLength={200}
                    autoComplete="off"
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
            <fieldset className="flex flex-col gap-2" aria-describedby="filter-tags-hint">
              <legend className="mb-1 text-sm font-medium">{t.tagsFilter}</legend>
              {tagOptions.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t.noTagsYet}</p>
              ) : (
                <div className="flex flex-wrap gap-2" data-testid="filter-tags">
                  {tagOptions.map((tag) => (
                    <label
                      key={tag.id}
                      className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm has-checked:border-primary has-checked:bg-accent-soft"
                    >
                      <input
                        type="checkbox"
                        name="tagIds"
                        value={tag.id}
                        defaultChecked={selectedTags.has(tag.id)}
                      />
                      <TagDot color={tag.color} />
                      {tag.name}
                    </label>
                  ))}
                </div>
              )}
              <p id="filter-tags-hint" className="text-xs text-muted-foreground">
                {t.tagsFilterHint}{" "}
                <Link href="/tags" className="font-medium text-primary hover:underline">
                  {t.manageTags}
                </Link>
              </p>
            </fieldset>
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
        {accounts.length > 0 && !filterError ? (
          <Card aria-labelledby="export-title">
            <h2 id="export-title" className="sr-only">
              {t.exportCsv}
            </h2>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <p className="text-sm text-muted-foreground">{t.exportHint}</p>
              <ExportButton
                path={exportPath("transactions", exportSearch(filters.query))}
                label={t.exportCsv}
                filename="finet-tranzactii.csv"
                testId="export-transactions"
              />
            </div>
          </Card>
        ) : null}
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
