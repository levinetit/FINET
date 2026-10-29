import type { Metadata } from "next";
import Link from "next/link";

import { suggestionToJson } from "@/app/api/v1/_lib/matching-handlers";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ro } from "@/messages/ro";
import { listAccounts } from "@/modules/accounts/accounts.service";
import { recurringRuleToJson } from "@/modules/recurring/recurring.schema";
import { listRecurringRules } from "@/modules/recurring/recurring.service";
import type { Currency } from "@/lib/money";
import { listRecurringSuggestions } from "@/modules/recurring/suggestions.service";

import { formatMinor } from "../../_lib/ledger-ui";
import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { formatDate } from "../../_lib/planning-ui";
import {
  type RecurringStatusFilter,
  UI_RECURRING_STATUSES,
  isPausedByArchivedAccount,
  ruleSummary,
  statusFilterOf,
  statusLabel,
} from "../../_lib/recurring-ui";
import { PageHeader } from "../page-header";

import { GenerateButton } from "./generate-button";
import { SuggestionActions } from "./suggestion-actions";

export const metadata: Metadata = { title: ro.recurring.title };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const FILTERS: readonly RecurringStatusFilter[] = ["all", ...UI_RECURRING_STATUSES];

/**
 * Plățile recurente (F5-B): contorul „X active · Y reguli scadente · Z total” (pe toate regulile),
 * filtrul pe stare (`?status=`, linkuri: funcționează și fără JavaScript), lista cu suma,
 * calendarul și următoarea scadență, plus „Generează scadentele” (mereu cu `Idempotency-Key`).
 * O regulă pusă pe pauză automat din cauza contului arhivat e marcată explicit.
 */
export default async function RecurringPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const page = await requireLedgerPage("/recurring");
  const t = ro.recurring;
  const filter = statusFilterOf((await searchParams).status);
  const actions = page.householdId ? (
    <Link href="/recurring/new" className={buttonClasses()}>
      {t.add}
    </Link>
  ) : null;
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
  const deps = { db: page.session.runtime.db };
  const result = await load(async () => {
    const [list, accounts, suggestions] = await Promise.all([
      listRecurringRules(deps, page.actor, householdId, filter === "all" ? {} : { status: filter }),
      listAccounts(deps, page.actor, householdId, { includeArchived: true }),
      // F7-B: propunerile din istoric (sub RLS; o eroare nu strică pagina).
      listRecurringSuggestions(deps, page.actor, householdId).catch(() => []),
    ]);
    return {
      suggestions: suggestions.map(suggestionToJson),
      rules: list.data.map(recurringRuleToJson),
      counts: list.counts,
      accountName: new Map(accounts.accounts.map((a) => [a.id, a.name])),
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
  const { rules, counts, accountName, suggestions } = result.value;
  const st = ro.suggestions;
  return (
    <>
      {header}
      <div className="flex flex-col gap-4">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <p className="font-semibold" data-testid="recurring-counts">
                {t.counts(counts.active, counts.due, counts.total)}
              </p>
              <p className="text-sm text-muted-foreground">{t.countsHint}</p>
            </div>
            <GenerateButton />
          </div>
        </Card>
        <Card aria-labelledby="suggestions-title" data-testid="recurring-suggestions">
          <CardHeader>
            <CardTitle id="suggestions-title">{st.title}</CardTitle>
            <CardDescription>{st.hint}</CardDescription>
          </CardHeader>
          {suggestions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{st.empty}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {suggestions.map((s) => (
                <li
                  key={s.signature}
                  className="flex flex-wrap items-start justify-between gap-3 py-3"
                  data-testid="suggestion-row"
                >
                  <div className="flex flex-col gap-1">
                    <span className="font-semibold">{s.description}</span>
                    <span className="text-sm text-muted-foreground">
                      {s.accountName} ·{" "}
                      {st.summary(
                        formatMinor(s.amountMinor, s.currency as Currency),
                        st.frequency[s.frequency] ?? s.frequency,
                        s.occurrences,
                        formatDate(s.nextOn),
                      )}
                    </span>
                  </div>
                  <SuggestionActions signature={s.signature} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <nav aria-label={t.filterLabel}>
          <ul className="flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <li key={f}>
                <Link
                  href={f === "all" ? "/recurring" : `/recurring?status=${f}`}
                  aria-current={f === filter ? "page" : undefined}
                  className={cn(
                    buttonClasses(f === filter ? "secondary" : "ghost"),
                    "min-h-10 px-3",
                  )}
                >
                  {t.filters[f]}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <Card>
          {rules.length === 0 ? (
            <p className="text-muted-foreground" data-testid="recurring-empty">
              {counts.total === 0 ? t.empty : t.emptyFiltered}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border" data-testid="recurring-list">
              {rules.map((r) => (
                <li key={r.id} data-testid="recurring-row" data-status={r.status}>
                  <Link
                    href={`/recurring/${r.id}`}
                    className="flex flex-col gap-1 py-3 hover:text-primary"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{r.description}</span>
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-xs font-semibold",
                          r.status === "active"
                            ? "bg-ok-soft"
                            : isPausedByArchivedAccount(r)
                              ? "bg-warn-soft"
                              : "bg-muted",
                        )}
                        data-testid="recurring-status"
                      >
                        {statusLabel(r)}
                      </span>
                      {r.due ? (
                        <span className="rounded bg-accent-soft px-1.5 py-0.5 text-xs font-semibold">
                          {t.dueBadge}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {ro.ledger.types[r.type]} · {accountName.get(r.accountId) ?? "—"} ·{" "}
                      {ruleSummary(r)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
