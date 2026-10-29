import type { Metadata } from "next";

import { ExportButton } from "@/components/planning/export-button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ro } from "@/messages/ro";

import { requirePageSession } from "../../../_lib/session";
import { PageHeader } from "../../page-header";

import { DeleteAccount } from "./delete-account";

export const metadata: Metadata = { title: ro.privacy.title };

/**
 * Setări → Datele mele (Faza 9, F9-B, ADR 0021; master prompt 6.3 „GDPR”, 5.6): exportul complet
 * al contului (`GET /api/v1/me/export`, arhivă ZIP descărcată prin `fetch` cu cookie, ca
 * exporturile CSV) și ștergerea contului (previzualizare + parola + „ȘTERGE”).
 */
export default async function PrivacyPage() {
  await requirePageSession("/settings/privacy");
  const t = ro.privacy;
  return (
    <>
      <PageHeader eyebrow={t.eyebrow} title={t.title} />
      <div className="flex flex-col gap-4">
        <Card aria-labelledby="export-titlu">
          <CardHeader>
            <CardTitle id="export-titlu">{t.exportTitle}</CardTitle>
            <CardDescription>{t.exportBody}</CardDescription>
          </CardHeader>
          <ExportButton
            path="/api/v1/me/export"
            label={t.exportButton}
            filename="finet-export.zip"
            testId="gdpr-export"
          />
          <p className="mt-2 text-sm text-muted-foreground">{t.exportHint}</p>
        </Card>
        <Card aria-labelledby="sterge-titlu">
          <CardHeader>
            <CardTitle id="sterge-titlu">{t.deleteTitle}</CardTitle>
            <CardDescription>{t.deleteBody}</CardDescription>
          </CardHeader>
          <DeleteAccount />
        </Card>
      </div>
    </>
  );
}
