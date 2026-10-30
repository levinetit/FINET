import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";

import { CategoryChart, DailyChart, MonthlyChart } from "@/components/planning/charts";
import { MonthSelector } from "@/components/planning/month-selector";
import {
  BudgetAlert,
  BudgetLine,
  GoalLine,
  StatCard,
  budgetName,
} from "@/components/planning/summary";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Currency } from "@/lib/money";
import { cn } from "@/lib/utils";
import { ro } from "@/messages/ro";
import { accountToJson, currencyTotalToJson } from "@/modules/accounts/accounts.schema";
import { listAccounts } from "@/modules/accounts/accounts.service";
import { budgetStatusToJson } from "@/modules/budgets/budgets.schema";
import { getBudgetStatuses } from "@/modules/budgets/budgets.service";
import { listCategories } from "@/modules/categories/categories.service";
import { dashboardToJson } from "@/modules/dashboard/dashboard.schema";
import { getDashboard } from "@/modules/dashboard/dashboard.service";
import { balancesToJson } from "@/modules/family/family.schema";
import { listMembers } from "@/modules/family/members.service";
import { getBalances } from "@/modules/family/settlements.service";
import { goalToJson } from "@/modules/goals/goals.schema";
import { listGoals } from "@/modules/goals/goals.service";
import { getMe } from "@/modules/profile/profile.service";
import { transactionToJson } from "@/modules/transactions/transactions.schema";
import { listTransactions } from "@/modules/transactions/transactions.service";

import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { formatCalendarDate, formatMinor, formatSigned } from "../../_lib/ledger-ui";
import { pageMonth } from "../../_lib/planning-page";
import { countDelta, formatMonth } from "../../_lib/planning-ui";
import { AccountsList, CurrencyTotals } from "../accounts/accounts-list";
import { PageHeader } from "../page-header";

export const metadata: Metadata = { title: ro.dashboard.title };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Acasă (Faza 3): luna aleasă (`?month=YYYY-MM`, ultimele 12 în selector, fereastra de 60 de luni
 * a API-ului), totalurile pe monedă cu comparația față de luna anterioară, graficele (SVG, fără
 * bibliotecă), bugetele cu semafor și avertizarea, obiectivele active, onboarding-ul în 3 pași,
 * soldurile și ultimele tranzacții. Totul citit din servicii pe server (`withMember` + RLS).
 */
export default async function DashboardPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const page = await requireLedgerPage("/dashboard");
  const { db } = page.session.runtime;
  const me = await getMe(db, page.actor.userId);
  const householdId = page.householdId;
  const { month: rawMonth } = await searchParams;
  const now = () => new Date();
  const selection = householdId ? await pageMonth(page, householdId, rawMonth, now) : null;

  const data =
    householdId && selection
      ? await load(async () => {
          const deps = { db, now };
          const query = { month: selection.month };
          const [dashboard, budgets, goals, accounts, recent, categories, balances, members] =
            await Promise.all([
              getDashboard(deps, page.actor, householdId, query),
              getBudgetStatuses(deps, page.actor, householdId, query),
              listGoals(deps, page.actor, householdId, { status: "active" }),
              listAccounts(deps, page.actor, householdId),
              listTransactions(deps, page.actor, householdId, { limit: 5 }),
              listCategories(deps, page.actor, householdId, { includeHidden: true }),
              // Faza 8: widgetul „Ai de dat / Ai de primit”.
              getBalances(deps, page.actor, householdId),
              listMembers(deps, page.actor, householdId),
            ]);
          return {
            dashboard: dashboardToJson(dashboard),
            budgets: budgets.map(budgetStatusToJson),
            goals: goals.map(goalToJson),
            accounts: accounts.accounts.map(accountToJson),
            totals: accounts.totals.map(currencyTotalToJson),
            recent: recent.data.map(transactionToJson),
            categoryName: new Map(categories.map((c) => [c.id, c.name] as const)),
            family: { me: balancesToJson(balances).me, members: members.length },
          };
        })
      : null;

  const t = ro.dashboard;
  const header = (
    <PageHeader
      eyebrow={me.household?.name}
      title={t.title}
      usageStats={page.usageStats}
      actions={
        selection ? (
          <MonthSelector action="/dashboard" month={selection.month} current={selection.current} />
        ) : null
      }
    />
  );
  const v = data?.ok ? data.value : null;
  const accountName = new Map(v ? v.accounts.map((a) => [a.id, a.name] as const) : []);
  const month = v?.dashboard.month ?? selection?.month ?? "";

  return (
    <>
      {header}
      <div className="flex flex-col gap-4">
        <p className="text-muted-foreground">{t.greeting(me.user.name)}</p>
        {selection?.invalid ? <Alert tone="info">{ro.planning.invalidMonth}</Alert> : null}
        {data && !data.ok ? <Alert>{t.loadError}</Alert> : null}
        {v ? <BudgetAlert statuses={v.budgets} month={month} /> : null}
        {v &&
        (v.family.members > 1 || v.family.me.some((m) => m.owesMinor > 0 || m.owedMinor > 0)) ? (
          <FamilyWidget me={v.family.me} />
        ) : null}
        {v && !v.dashboard.onboarding.completed ? (
          <Onboarding
            hasAccount={v.dashboard.onboarding.hasAccount}
            steps={v.dashboard.onboarding.steps}
          />
        ) : null}

        {v ? (
          v.dashboard.currencies.length === 0 ? (
            <Card>
              <p className="text-muted-foreground" data-testid="dashboard-empty">
                {t.noData}
              </p>
            </Card>
          ) : (
            v.dashboard.currencies.map((c) => {
              const cur = c.currency as Currency;
              const prev = v.dashboard.previousMonth;
              return (
                <Card
                  key={c.currency}
                  aria-labelledby={`summary-${c.currency}`}
                  data-testid={`summary-${c.currency}`}
                >
                  <CardHeader>
                    <CardTitle id={`summary-${c.currency}`}>
                      {t.summaryTitle(c.currency)} · {formatMonth(month)}
                    </CardTitle>
                  </CardHeader>
                  <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <StatCard
                      label={t.income}
                      value={formatMinor(c.totals.incomeMinor, cur)}
                      delta={c.comparison.income}
                      previousMonth={prev}
                      testId="stat-income"
                    />
                    <StatCard
                      label={t.expense}
                      value={formatMinor(c.totals.expenseMinor, cur)}
                      delta={c.comparison.expense}
                      previousMonth={prev}
                      testId="stat-expense"
                    />
                    <StatCard
                      label={t.net}
                      value={formatMinor(c.totals.netMinor, cur)}
                      delta={c.comparison.net}
                      previousMonth={prev}
                      testId="stat-net"
                    />
                    <StatCard
                      label={t.count}
                      value={c.totals.transactionCount}
                      delta={countDelta(c.totals.transactionCount, c.previous.transactionCount)}
                      previousMonth={prev}
                      testId="stat-count"
                    />
                  </dl>
                  <div className="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-2">
                    <section aria-labelledby={`cat-${c.currency}`}>
                      <h3 id={`cat-${c.currency}`} className="mb-3 font-bold">
                        {t.byCategoryTitle}
                      </h3>
                      <CategoryChart
                        slices={c.byCategory}
                        currency={cur}
                        id={`cat-${c.currency}`}
                      />
                    </section>
                    <div className="flex flex-col gap-6">
                      <section aria-labelledby={`monthly-${c.currency}`}>
                        <h3 id={`monthly-${c.currency}`} className="mb-3 font-bold">
                          {t.monthlyTitle}
                        </h3>
                        <MonthlyChart points={c.monthly} currency={cur} />
                      </section>
                      <section aria-labelledby={`daily-${c.currency}`}>
                        <h3 id={`daily-${c.currency}`} className="mb-3 font-bold">
                          {t.dailyTitle}
                        </h3>
                        <DailyChart points={c.daily} currency={cur} />
                      </section>
                    </div>
                  </div>
                </Card>
              );
            })
          )
        ) : null}

        {v ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card aria-labelledby="budgets-title">
              <CardHeader>
                <CardTitle id="budgets-title">{t.budgetsTitle}</CardTitle>
              </CardHeader>
              {v.budgets.length === 0 ? (
                <p className="text-muted-foreground">{t.budgetsEmpty}</p>
              ) : (
                <ul className="flex flex-col gap-4" data-testid="dashboard-budgets">
                  {v.budgets.map((b) => (
                    <li key={b.id}>
                      <BudgetLine
                        status={b}
                        name={budgetName(b, v.categoryName)}
                        href={`/budgets/${b.id}`}
                      />
                    </li>
                  ))}
                </ul>
              )}
              <Link
                href={`/budgets?month=${month}`}
                className="mt-3 inline-block text-sm font-medium text-primary hover:underline"
              >
                {t.seeBudgets}
              </Link>
            </Card>
            <Card aria-labelledby="goals-title">
              <CardHeader>
                <CardTitle id="goals-title">{t.goalsTitle}</CardTitle>
              </CardHeader>
              {v.goals.length === 0 ? (
                <p className="text-muted-foreground">{t.goalsEmpty}</p>
              ) : (
                <ul className="flex flex-col gap-4" data-testid="dashboard-goals">
                  {v.goals.map((g) => (
                    <li key={g.id}>
                      <GoalLine goal={g} href={`/goals/${g.id}`} />
                    </li>
                  ))}
                </ul>
              )}
              <Link
                href="/goals"
                className="mt-3 inline-block text-sm font-medium text-primary hover:underline"
              >
                {t.seeGoals}
              </Link>
            </Card>
          </div>
        ) : null}

        {v ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card aria-labelledby="balances-title">
              <CardHeader>
                <CardTitle id="balances-title">{t.balancesTitle}</CardTitle>
              </CardHeader>
              <div className="flex flex-col gap-4">
                <CurrencyTotals totals={v.totals} />
                {v.accounts.length > 0 ? (
                  <AccountsList accounts={v.accounts} testId="dashboard-accounts" />
                ) : null}
                <Link href="/accounts" className="text-sm font-medium text-primary hover:underline">
                  {t.seeAllAccounts}
                </Link>
              </div>
            </Card>
            <Card aria-labelledby="recent-title">
              <CardHeader>
                <CardTitle id="recent-title">{t.recentTitle}</CardTitle>
              </CardHeader>
              {v.recent.length === 0 ? (
                <p className="text-muted-foreground">{t.recentEmpty}</p>
              ) : (
                <ul
                  className="flex flex-col divide-y divide-border"
                  data-testid="recent-transactions"
                >
                  {v.recent.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">
                          {r.description ?? r.merchant ?? ro.ledger.types[r.type]}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {formatCalendarDate(r.occurredOn)} · {accountName.get(r.accountId) ?? "—"}
                        </span>
                      </span>
                      <span className="font-mono whitespace-nowrap tabular-nums">
                        {r.type === "transfer"
                          ? formatMinor(r.amountMinor, r.currency)
                          : formatSigned(r.type, r.amountMinor, r.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Link
                href="/transactions"
                className="mt-3 inline-block text-sm font-medium text-primary hover:underline"
              >
                {t.seeAllTransactions}
              </Link>
            </Card>
          </div>
        ) : null}

        <Card aria-labelledby="household-title">
          <h2 id="household-title" className="sr-only">
            {t.household}
          </h2>
          {me.household ? (
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-muted-foreground">{t.household}</dt>
                <dd className="font-semibold" data-testid="household-name">
                  {me.household.name}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">{t.role}</dt>
                <dd className="font-semibold" data-testid="household-role">
                  {t.roles[me.household.role] ?? me.household.role}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-muted-foreground">{t.noHousehold}</p>
          )}
        </Card>
      </div>
    </>
  );
}

type StepKey = "import" | "budget" | "goal";

/**
 * Onboarding-ul în 3 pași (6.4), cât timp nu sunt făcuți: (1) tranzacții — pasul trimite la
 * „Adaugă manual” (sau întâi la „Adaugă cont”, dacă nu există conturi); bonurile și extrasele se
 * pot importa din Scanează/Import; (2) un buget; (3) un obiectiv (ADR 0008).
 */
function Onboarding({
  hasAccount,
  steps,
}: Readonly<{ hasAccount: boolean; steps: ReadonlyArray<{ key: StepKey; done: boolean }> }>) {
  const t = ro.dashboard;
  const links: Record<StepKey, { href: string; text: string; title: string; body: string }> = {
    import: hasAccount
      ? {
          href: "/transactions/new?type=expense",
          text: t.steps.import.action,
          title: t.steps.import.title,
          body: t.steps.import.body,
        }
      : {
          href: "/accounts/new",
          text: t.steps.account.action,
          title: t.steps.account.title,
          body: t.steps.account.body,
        },
    budget: {
      href: "/budgets/new",
      text: t.steps.budget.action,
      title: t.steps.budget.title,
      body: t.steps.budget.body,
    },
    goal: {
      href: "/goals/new",
      text: t.steps.goal.action,
      title: t.steps.goal.title,
      body: t.steps.goal.body,
    },
  };
  return (
    <Card aria-labelledby="onboarding-title" data-testid="onboarding">
      <CardHeader>
        <CardTitle id="onboarding-title">{t.onboardingTitle}</CardTitle>
        <CardDescription>{t.onboardingIntro}</CardDescription>
      </CardHeader>
      <ol className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {steps.map((s, i) => {
          const step = links[s.key];
          return (
            <li
              key={s.key}
              className={cn(
                "flex flex-col gap-2 rounded-md border px-4 py-3",
                s.done ? "border-ok bg-ok-soft" : "border-border",
              )}
              data-testid={`onboarding-${s.key}`}
              data-done={s.done}
            >
              <span className="text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                {i + 1}. {s.done ? t.onboardingDone : t.onboardingTodo}
              </span>
              <span className="font-semibold">{step.title}</span>
              <span className="text-sm text-muted-foreground">{step.body}</span>
              {s.done ? null : (
                <Link href={step.href} className={buttonClasses("outline", "sm", "self-start")}>
                  {step.text}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

/**
 * Widgetul de împărțire (master prompt, „Dashboard”): „Ai de dat / Ai de primit”, pe monedă, din
 * soldurile reciproce (Faza 8). Fără nume și fără detalii: acestea sunt pe pagina „Familie”.
 */
function FamilyWidget({
  me,
}: Readonly<{
  me: ReadonlyArray<Readonly<{ currency: Currency; owesMinor: number; owedMinor: number }>>;
}>) {
  const f = ro.family;
  const open = me.filter((m) => m.owesMinor > 0 || m.owedMinor > 0);
  return (
    <Card aria-labelledby="family-widget" data-testid="family-widget">
      <CardHeader>
        <CardTitle id="family-widget">{f.widgetTitle}</CardTitle>
      </CardHeader>
      {open.length === 0 ? (
        <p className="text-muted-foreground" data-testid="family-widget-empty">
          {f.widgetEmpty}
        </p>
      ) : (
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {open.map((m) => (
            <Fragment key={m.currency}>
              <div className="rounded-md bg-surface-2 px-4 py-3">
                <dt className="text-sm text-muted-foreground">{`${f.youOwe} (${m.currency})`}</dt>
                <dd
                  className="font-mono text-xl font-semibold tabular-nums"
                  data-testid={`widget-owes-${m.currency}`}
                >
                  {formatMinor(m.owesMinor, m.currency)}
                </dd>
              </div>
              <div className="rounded-md bg-surface-2 px-4 py-3">
                <dt className="text-sm text-muted-foreground">{`${f.youAreOwed} (${m.currency})`}</dt>
                <dd
                  className="font-mono text-xl font-semibold tabular-nums"
                  data-testid={`widget-owed-${m.currency}`}
                >
                  {formatMinor(m.owedMinor, m.currency)}
                </dd>
              </div>
            </Fragment>
          ))}
        </dl>
      )}
      <div>
        <Link href="/family" className={buttonClasses("outline", "sm")}>
          {f.seeFamily}
        </Link>
      </div>
    </Card>
  );
}
