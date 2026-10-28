import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { ro } from "@/messages/ro";
import { isValidId } from "@/modules/ledger/input";
import { recurringRuleToJson } from "@/modules/recurring/recurring.schema";
import { getRecurringRule, todayLocal } from "@/modules/recurring/recurring.service";

import { formOptions } from "../../../_lib/ledger-options";
import { load, requireLedgerPage } from "../../../_lib/ledger-page";
import { ruleSummary, statusLabel } from "../../../_lib/recurring-ui";
import { PageHeader } from "../../page-header";
import { RecurringForm } from "../recurring-form";

import { RecurringActions } from "./recurring-actions";

export const metadata: Metadata = { title: ro.recurring.editTitle };

/**
 * O regulă recurentă: starea (cu motivul „cont arhivat” când e cazul), pauza/reluarea, editarea și
 * ștergerea. Id invalid, inexistent sau din altă gospodărie → 404 uniform.
 */
export default async function RecurringRulePage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  const page = await requireLedgerPage(`/recurring/${id}`);
  if (!isValidId(id) || !page.householdId) notFound();
  const householdId = page.householdId;
  const { db } = page.session.runtime;
  const result = await load(async () => {
    const rule = recurringRuleToJson(
      await getRecurringRule({ db }, page.actor, householdId, id, todayLocal()),
    );
    const options = await formOptions(db, page.actor, householdId, {
      accountId: rule.accountId,
      categoryId: rule.categoryId,
    });
    return { rule, options };
  });
  if (!result.ok) {
    return (
      <>
        <PageHeader title={ro.recurring.editTitle} usageStats={page.usageStats} />
        <Alert>{ro.ledger.loadError}</Alert>
      </>
    );
  }
  const { rule, options } = result.value;
  return (
    <>
      <PageHeader
        eyebrow={ro.recurring.editTitle}
        title={rule.description}
        usageStats={page.usageStats}
      />
      <div className="flex flex-col gap-4">
        <Card aria-label={ro.recurring.actionsTitle}>
          <p className="font-semibold" data-testid="recurring-detail-status">
            {statusLabel(rule)}
          </p>
          <p className="text-sm text-muted-foreground" data-testid="recurring-detail-summary">
            {ruleSummary(rule)}
          </p>
        </Card>
        <RecurringActions rule={rule} />
        <RecurringForm
          rule={rule}
          accounts={options.accounts}
          categories={options.categories}
          today={todayLocal()}
        />
      </div>
    </>
  );
}
