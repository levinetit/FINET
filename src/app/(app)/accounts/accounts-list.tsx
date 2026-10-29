import Link from "next/link";

import type { MoneyJson } from "@/lib/money";
import { ro } from "@/messages/ro";
import type { AccountJson } from "@/modules/accounts/accounts.schema";

import { formatMinor } from "../../_lib/ledger-ui";

/** Totalurile pe monedă (fiecare monedă separat, fără conversie, 5.1). */
export function CurrencyTotals({ totals }: Readonly<{ totals: readonly MoneyJson[] }>) {
  if (totals.length === 0) {
    return <p className="text-muted-foreground">{ro.dashboard.balancesEmpty}</p>;
  }
  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="currency-totals">
      {totals.map((t) => (
        <div
          key={t.currency}
          className="rounded-md bg-surface-2 px-4 py-3"
          data-testid={`total-${t.currency}`}
        >
          <dt className="text-sm text-muted-foreground">{ro.ledger.currencyTotal(t.currency)}</dt>
          <dd className="font-mono text-xl font-semibold tabular-nums">
            {formatMinor(t.amountMinor, t.currency)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Lista conturilor cu soldul curent; fiecare rând duce la pagina contului. */
export function AccountsList({
  accounts,
  testId,
}: Readonly<{ accounts: readonly AccountJson[]; testId: string }>) {
  return (
    <ul className="flex flex-col divide-y divide-border" data-testid={testId}>
      {accounts.map((a) => (
        <li key={a.id} data-testid="account-row" data-account-name={a.name}>
          <Link
            href={`/accounts/${a.id}`}
            className="flex items-center justify-between gap-3 py-3 hover:text-primary"
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-semibold">{a.name}</span>
              <span className="text-sm text-muted-foreground">
                {ro.ledger.accountTypes[a.type] ?? a.type} · {a.currency}
                {a.archived ? ` · ${ro.accounts.archivedBadge}` : ""}
                {a.ownerUserId ? ` · ${ro.accounts.personalBadge}` : ""}
              </span>
            </span>
            <span
              className={
                "font-mono font-semibold whitespace-nowrap tabular-nums" +
                (a.balanceMinor < 0 ? " text-bad" : "")
              }
              data-testid="account-balance"
            >
              {formatMinor(a.balanceMinor, a.currency)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
