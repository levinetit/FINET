"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConfirmButton } from "@/components/ledger/confirm-button";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ro } from "@/messages/ro";

import { goToLogin } from "../../_lib/api-client";
import { apiErrors } from "../../_lib/ledger-ui";
import { insightsHref } from "../../_lib/insights-ui";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

/**
 * Arhivarea și ștergerea unui raport PROPRIU (cele de sistem nu se modifică). Mutațiile prin
 * `/api/v1/report-definitions/{id}`; după succes se revine la lista de rapoarte.
 */
export function OwnReportActions({ id }: Readonly<{ id: string }>) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [error, setError] = useState<string | null>(null);
  const busy = pending || !hydrated;
  const t = ro.insights.report;

  async function run(method: "PATCH" | "DELETE") {
    setError(null);
    const result =
      method === "PATCH"
        ? await submit(`/api/v1/report-definitions/${id}`, "PATCH", { archived: true })
        : await submit(`/api/v1/report-definitions/${id}`, "DELETE");
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(apiErrors(result).form ?? ro.ledger.errors.generic);
      return;
    }
    router.push(insightsHref({}, "rapoarte"));
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void run("PATCH")}
          data-testid="report-archive"
        >
          {t.archive}
        </Button>
        <ConfirmButton
          label={t.delete}
          question={t.deleteConfirm}
          busy={busy}
          onConfirm={() => void run("DELETE")}
        />
      </div>
      <Alert>{error}</Alert>
    </div>
  );
}
