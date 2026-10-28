"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConfirmButton } from "@/components/ledger/confirm-button";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardContent } from "@/components/ui/card";
import { ro } from "@/messages/ro";

import { goToLogin } from "../../../_lib/api-client";
import { apiErrors } from "../../../_lib/ledger-ui";
import { useHydrated } from "../../../_lib/use-hydrated";
import { useSubmit } from "../../../_lib/use-submit";

/** Arhivarea/dezarhivarea și ștergerea unui cont (ștergerea doar pentru un cont gol, 5.6). */
export function AccountActions({
  id,
  archived,
  empty,
}: Readonly<{ id: string; archived: boolean; empty: boolean }>) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function toggleArchive() {
    setError(null);
    setInfo(null);
    const result = await submit(
      `/api/v1/accounts/${id}/${archived ? "unarchive" : "archive"}`,
      "POST",
    );
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(apiErrors(result).form);
      return;
    }
    setInfo(archived ? ro.accounts.unarchivedOk : ro.accounts.archivedOk);
    router.refresh();
  }

  async function remove() {
    setError(null);
    setInfo(null);
    const result = await submit(`/api/v1/accounts/${id}`, "DELETE", undefined, {
      lockOnSuccess: true,
    });
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(apiErrors(result).form);
      return;
    }
    router.push("/accounts");
    router.refresh();
  }

  const busy = pending || !hydrated;
  return (
    <Card>
      <CardContent>
        <div className="flex flex-wrap items-start gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void toggleArchive()}>
            {archived ? ro.accounts.unarchive : ro.accounts.archive}
          </Button>
          {empty ? (
            <ConfirmButton
              label={ro.ledger.delete}
              question={ro.accounts.deleteConfirm}
              busy={busy}
              onConfirm={() => void remove()}
            />
          ) : null}
        </div>
        {empty ? null : <CardDescription>{ro.accounts.deleteHint}</CardDescription>}
        <Alert>{error}</Alert>
        <Alert tone="ok">{info}</Alert>
      </CardContent>
    </Card>
  );
}
