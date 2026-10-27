import type { Metadata } from "next";

import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { ro } from "@/messages/ro";
import { getMe } from "@/modules/profile/profile.service";

import { requirePageSession } from "../../_lib/session";
import { PageHeader } from "../page-header";

export const metadata: Metadata = { title: ro.dashboard.title };

export default async function DashboardPage() {
  const session = await requirePageSession("/dashboard");
  const me = await getMe(session.runtime.db, session.userId);

  return (
    <>
      <PageHeader eyebrow={me.household?.name} title={ro.dashboard.title} />
      <div className="flex flex-col gap-4">
        <Card>
          <CardTitle>{ro.dashboard.greeting(me.user.name)}</CardTitle>
          <CardDescription className="mt-2">{ro.dashboard.placeholder}</CardDescription>
        </Card>
        <Card aria-labelledby="household-title">
          <h2 id="household-title" className="sr-only">
            {ro.dashboard.household}
          </h2>
          {me.household ? (
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-muted-foreground">{ro.dashboard.household}</dt>
                <dd className="font-semibold" data-testid="household-name">
                  {me.household.name}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">{ro.dashboard.role}</dt>
                <dd className="font-semibold" data-testid="household-role">
                  {ro.dashboard.roles[me.household.role] ?? me.household.role}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-muted-foreground">{ro.dashboard.noHousehold}</p>
          )}
        </Card>
      </div>
    </>
  );
}
