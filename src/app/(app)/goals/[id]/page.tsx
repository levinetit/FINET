import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { GoalLine } from "@/components/planning/summary";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { DB_CURRENCIES } from "@/db/schema";
import { ro } from "@/messages/ro";
import { listAccounts } from "@/modules/accounts/accounts.service";
import { goalToJson } from "@/modules/goals/goals.schema";
import { getGoal } from "@/modules/goals/goals.service";
import { isValidId } from "@/modules/ledger/input";

import { load, requireLedgerPage } from "../../../_lib/ledger-page";
import { PageHeader } from "../../page-header";
import { GoalForm } from "../goal-form";

import { GoalActions } from "./goal-actions";

export const metadata: Metadata = { title: ro.goals.editTitle };

/**
 * Un obiectiv: progresul, contribuțiile (adaugă/scade), abandonarea/reluarea, editarea și
 * ștergerea. Id invalid, inexistent sau din altă gospodărie → 404 uniform.
 */
export default async function GoalPage({ params }: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  const page = await requireLedgerPage(`/goals/${id}`);
  if (!isValidId(id) || !page.householdId) notFound();
  const householdId = page.householdId;
  const deps = { db: page.session.runtime.db };
  const result = await load(async () => {
    const goal = goalToJson(await getGoal(deps, page.actor, householdId, id));
    const accounts = await listAccounts(deps, page.actor, householdId, { includeArchived: true });
    return {
      goal,
      accounts: accounts.accounts
        .filter((a) => a.archivedAt === null || a.id === goal.accountId)
        .map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
    };
  });
  if (!result.ok) {
    return (
      <>
        <PageHeader title={ro.goals.editTitle} usageStats={page.usageStats} />
        <Alert>{ro.ledger.loadError}</Alert>
      </>
    );
  }
  const { goal, accounts } = result.value;
  return (
    <>
      <PageHeader eyebrow={ro.goals.editTitle} title={goal.name} usageStats={page.usageStats} />
      <div className="flex flex-col gap-4">
        <Card aria-label={ro.goals.saved}>
          <GoalLine goal={goal} />
        </Card>
        <GoalActions goal={goal} />
        <GoalForm
          goal={goal}
          accounts={accounts}
          currencies={DB_CURRENCIES}
          defaultCurrency={goal.currency}
        />
      </div>
    </>
  );
}
