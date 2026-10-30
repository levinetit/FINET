import type { Metadata } from "next";
import Link from "next/link";

import { ExportButton } from "@/components/planning/export-button";
import { TableExportButtons } from "@/components/planning/table-export-buttons";
import { GoalLine } from "@/components/planning/summary";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { GOAL_STATUSES } from "@/db/schema";
import { ro } from "@/messages/ro";
import { goalToJson } from "@/modules/goals/goals.schema";
import { listGoals } from "@/modules/goals/goals.service";

import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { exportPath } from "../../_lib/planning-ui";
import { PageHeader } from "../page-header";

export const metadata: Metadata = { title: ro.goals.title };

/** Obiectivele, grupate pe stare (active, atinse, abandonate), cu progresul și exportul CSV. */
export default async function GoalsPage() {
  const page = await requireLedgerPage("/goals");
  const t = ro.goals;
  const actions = page.householdId ? (
    <Link href="/goals/new" className={buttonClasses()}>
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
  const result = await load(async () =>
    (await listGoals({ db: page.session.runtime.db }, page.actor, householdId)).map(goalToJson),
  );
  if (!result.ok) {
    return (
      <>
        {header}
        <Alert>{ro.ledger.loadError}</Alert>
      </>
    );
  }
  const goals = result.value;
  return (
    <>
      {header}
      <div className="flex flex-col gap-4">
        {goals.length === 0 ? (
          <Card>
            <p className="text-muted-foreground" data-testid="goals-empty">
              {t.empty}
            </p>
          </Card>
        ) : (
          GOAL_STATUSES.map((status) => {
            const list = goals.filter((g) => g.status === status);
            if (list.length === 0) return null;
            return (
              <Card key={status} aria-labelledby={`goals-${status}`}>
                <CardHeader>
                  <CardTitle id={`goals-${status}`}>{t.lists[status]}</CardTitle>
                </CardHeader>
                <ul className="flex flex-col gap-5" data-testid={`goals-${status}`}>
                  {list.map((g) => (
                    <li key={g.id}>
                      <GoalLine goal={g} href={`/goals/${g.id}`} />
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })
        )}
        <div className="flex flex-wrap items-start gap-3">
          <ExportButton
            path={exportPath("goals")}
            label={t.exportCsv}
            filename="finet-obiective.csv"
            testId="export-goals"
          />
          <TableExportButtons kind="goals" testId="export-goals" />
        </div>
      </div>
    </>
  );
}
