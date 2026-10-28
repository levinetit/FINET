import type { Metadata } from "next";

import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { BUDGET_SCOPES, DB_CURRENCIES } from "@/db/schema";
import { ro } from "@/messages/ro";
import { listCategories } from "@/modules/categories/categories.service";
import { getMe } from "@/modules/profile/profile.service";

import { load, requireLedgerPage } from "../../../_lib/ledger-page";
import { PageHeader } from "../../page-header";
import { BudgetForm } from "../budget-form";

export const metadata: Metadata = { title: ro.budgets.newTitle };

export default async function NewBudgetPage() {
  const page = await requireLedgerPage("/budgets/new");
  const header = (
    <PageHeader
      eyebrow={ro.budgets.title}
      title={ro.budgets.newTitle}
      usageStats={page.usageStats}
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
  const { db } = page.session.runtime;
  const result = await load(async () => {
    const [categories, me] = await Promise.all([
      listCategories({ db }, page.actor, householdId, { kind: "expense" }),
      getMe(db, page.actor.userId),
    ]);
    return {
      categories: categories.map((c) => ({ id: c.id, name: c.name })),
      currency: me.household?.defaultCurrency ?? me.preferences.defaultCurrency,
    };
  });
  return (
    <>
      {header}
      {result.ok ? (
        <BudgetForm
          categories={result.value.categories}
          currencies={DB_CURRENCIES}
          scopes={BUDGET_SCOPES}
          defaultCurrency={result.value.currency}
        />
      ) : (
        <Alert>{ro.ledger.loadError}</Alert>
      )}
    </>
  );
}
