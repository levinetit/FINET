"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ro } from "@/messages/ro";
import type { RecurringRuleJson } from "@/modules/recurring/recurring.schema";

import { goToLogin } from "../../../_lib/api-client";
import { apiErrors } from "../../../_lib/ledger-ui";
import { isPausedByArchivedAccount } from "../../../_lib/recurring-ui";
import { useHydrated } from "../../../_lib/use-hydrated";
import { useSubmit } from "../../../_lib/use-submit";

/**
 * Pauza și reluarea unei reguli (pagina rămâne deschisă). Reluarea NU generează retroactiv lunile
 * sărite (o spune și indiciul). O regulă pusă pe pauză automat din cauza contului arhivat explică
 * motivul; reluarea ei e refuzată de server (409 `account_archived`) până când contul e dezarhivat
 * sau regula e mutată pe alt cont. O regulă completată nu are acțiuni de stare.
 */
export function RecurringActions({ rule }: Readonly<{ rule: RecurringRuleJson }>) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const t = ro.recurring;
  const busy = pending || !hydrated;

  async function change(action: "pause" | "resume") {
    setError(null);
    setInfo(null);
    const result = await submit(`/api/v1/recurring/${rule.id}/${action}`, "POST");
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(
        result.error?.reason === "account_archived" ? t.pausedArchivedHint : apiErrors(result).form,
      );
      return;
    }
    setInfo(action === "pause" ? t.paused : t.resumed);
    router.refresh();
  }

  return (
    <Card aria-labelledby="recurring-actions-title">
      <CardHeader>
        <CardTitle id="recurring-actions-title">{t.actionsTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        {isPausedByArchivedAccount(rule) ? (
          <p className="text-sm" data-testid="recurring-archived-hint">
            {t.pausedArchivedHint}
          </p>
        ) : null}
        {rule.status === "active" ? (
          <div>
            <Button variant="outline" disabled={busy} onClick={() => void change("pause")}>
              {t.pause}
            </Button>
          </div>
        ) : rule.status === "paused" ? (
          <div className="flex flex-col gap-1">
            <div>
              <Button
                disabled={busy}
                onClick={() => void change("resume")}
                aria-describedby="recurring-resume-hint"
              >
                {t.resume}
              </Button>
            </div>
            <p id="recurring-resume-hint" className="text-sm text-muted-foreground">
              {t.resumeHint}
            </p>
          </div>
        ) : null}
        <Alert>{error}</Alert>
        <Alert tone="ok">{info}</Alert>
      </CardContent>
    </Card>
  );
}
