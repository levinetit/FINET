"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConfirmButton } from "@/components/ledger/confirm-button";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ro } from "@/messages/ro";

import { goToLogin } from "../../_lib/api-client";
import { apiErrors } from "../../_lib/ledger-ui";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

/**
 * Anularea unui import confirmat (F7-B): întâi fără decizie; dacă unele tranzacții au fost
 * modificate după import (409 `statement_import_has_edited`), utilizatorul alege EXPLICIT dacă le
 * păstrează sau le șterge. Renunțarea la o previzualizare: ștergerea ei (nimic importat).
 */
export function StatementActions({ id, status }: Readonly<{ id: string; status: string }>) {
  const t = ro.statements;
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [edited, setEdited] = useState(false);

  async function cancel(editedPolicy?: "keep" | "delete") {
    setError(null);
    setInfo(null);
    const result = await submit<{ keptEdited: number }>(
      `/api/v1/statements/imports/${id}/cancel`,
      "POST",
      editedPolicy ? { editedPolicy } : {},
    );
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      if (result.error?.reason === "statement_import_has_edited") setEdited(true);
      setError(apiErrors(result).form);
      return;
    }
    setEdited(false);
    setInfo(t.cancelled(result.data?.keptEdited ?? 0));
    router.refresh();
  }

  async function discard() {
    setError(null);
    const result = await submit(`/api/v1/statements/imports/${id}`, "DELETE");
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(apiErrors(result).form);
      return;
    }
    router.push("/statements");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      {status === "imported" ? (
        <ConfirmButton
          label={t.cancel}
          question={t.cancelQuestion}
          confirmLabel={t.cancel}
          busy={pending}
          disabled={!hydrated}
          onConfirm={() => void cancel()}
        />
      ) : null}
      {status === "previewed" ? (
        <ConfirmButton
          label={t.discard}
          question={t.discardQuestion}
          confirmLabel={t.discard}
          busy={pending}
          disabled={!hydrated}
          onConfirm={() => void discard()}
        />
      ) : null}
      {edited ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label={t.editedTitle}>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void cancel("keep")}
            data-testid="cancel-keep"
          >
            {t.keepEdited}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={() => void cancel("delete")}
            data-testid="cancel-delete"
          >
            {t.deleteEdited}
          </Button>
        </div>
      ) : null}
      <Alert>{error}</Alert>
      <Alert tone="ok">{info}</Alert>
    </div>
  );
}
