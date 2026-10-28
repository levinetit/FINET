import type { Metadata } from "next";

import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { CATEGORY_KINDS } from "@/db/schema";
import { ro } from "@/messages/ro";
import { categoryToJson } from "@/modules/categories/categories.schema";
import { listCategories } from "@/modules/categories/categories.service";

import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { PageHeader } from "../page-header";

import { CategoriesManager } from "./categories-manager";

export const metadata: Metadata = { title: ro.categories.title };

export default async function CategoriesPage() {
  const page = await requireLedgerPage("/categories");
  const header = (
    <PageHeader
      eyebrow={ro.categories.eyebrow}
      title={ro.categories.title}
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
  const result = await load(() =>
    listCategories({ db: page.session.runtime.db }, page.actor, householdId, {
      includeHidden: true,
    }),
  );
  return (
    <>
      {header}
      {result.ok ? (
        <CategoriesManager categories={result.value.map(categoryToJson)} kinds={CATEGORY_KINDS} />
      ) : (
        <Alert>{ro.ledger.loadError}</Alert>
      )}
    </>
  );
}
