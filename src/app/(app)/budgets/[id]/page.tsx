import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BudgetLine, budgetName } from "@/components/planning/summary";
import { Alert } from "@/components/ui/alert";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { BUDGET_SCOPES, DB_CURRENCIES } from "@/db/schema";
import { ro } from "@/messages/ro";
import { budgetStatusToJson, budgetToJson } from "@/modules/budgets/budgets.schema";
import { getBudget, getBudgetStatuses } from "@/modules/budgets/budgets.service";
import { listCategories } from "@/modules/categories/categories.service";
import { isValidId } from "@/modules/ledger/input";

import { load, requireLedgerPage } from "../../../_lib/ledger-page";
import { formatMonth } from "../../../_lib/planning-ui";
import { PageHeader } from "../../page-header";
import { BudgetForm } from "../budget-form";

export const metadata: Metadata = { title: ro.budgets.editTitle };

/**
 * Un buget: starea lunii curente (dacă e activ), editarea limitei și a pragului, arhivarea și
 * ștergerea. Id invalid, inexistent, străin sau personal al altui membru → 404 uniform.
 */
export default async function BudgetPage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  const page = await requireLedgerPage(`/budgets/${id}`);
  if (!isValidId(id) || !page.householdId) notFound();
  const householdId = page.householdId;
  const deps = { db: page.session.runtime.db };
  const result = await load(async () => {
    const budget = budgetToJson(await getBudget(deps, page.actor, householdId, id));
    const [statuses, categories] = await Promise.all([
      getBudgetStatuses(deps, page.actor, householdId, {}),
      listCategories(deps, page.actor, householdId, { includeHidden: true }),
    ]);
    return {
      budget,
      status: statuses.map(budgetStatusToJson).find((s) => s.id === budget.id) ?? null,
      categories: categories
        .filter((c) => c.kind === "expense")
        .map((c) => ({ id: c.id, name: c.name })),
      categoryName: new Map(categories.map((c) => [c.id, c.name] as const)),
    };
  });
  if (!result.ok) {
    return (
      <>
        <PageHeader title={ro.budgets.editTitle} usageStats={page.usageStats} />
        <Alert>{ro.ledger.loadError}</Alert>
      </>
    );
  }
  const { budget, status, categories, categoryName } = result.value;
  const name = budgetName(budget, categoryName);
  return (
    <>
      <PageHeader eyebrow={ro.budgets.editTitle} title={name} usageStats={page.usageStats} />
      <div className="flex flex-col gap-4">
        {status ? (
          <Card aria-labelledby="budget-status-title">
            <CardHeader>
              <CardTitle id="budget-status-title">{formatMonth(status.month)}</CardTitle>
            </CardHeader>
            <BudgetLine status={status} name={name} />
          </Card>
        ) : null}
        <BudgetForm
          budget={budget}
          categories={categories}
          currencies={DB_CURRENCIES}
          scopes={BUDGET_SCOPES}
          defaultCurrency={budget.currency}
        />
      </div>
    </>
  );
}
