"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConfirmButton } from "@/components/ledger/confirm-button";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { ro } from "@/messages/ro";

import { goToLogin } from "../../_lib/api-client";
import { apiErrors } from "../../_lib/ledger-ui";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

/** Acțiunile unui rând din lista bonurilor: vezi, reprocesează (dacă nu e salvat), șterge. */
export function ReceiptRowActions({ id, saved }: Readonly<{ id: string; saved: boolean }>) {
  const t = ro.receipts;
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function run(path: string, method: "POST" | "DELETE", done: string) {
    setError(null);
    setInfo(null);
    const result = await submit(path, method);
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(apiErrors(result).form);
      return;
    }
    setInfo(done);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/receipts/${id}`}
          className={buttonClasses("outline", "sm")}
          data-testid="receipt-view"
        >
          {t.view}
        </Link>
        {!saved ? (
          <ConfirmButton
            label={t.reprocess}
            question={t.reprocessConfirm}
            confirmLabel={t.reprocess}
            busyLabel={t.reprocessing}
            title={t.reprocessHint}
            busy={pending}
            disabled={!hydrated}
            onConfirm={() => void run(`/api/v1/receipts/${id}/reprocess`, "POST", t.reprocessed)}
          />
        ) : null}
        <ConfirmButton
          label={ro.ledger.delete}
          question={t.deleteConfirm}
          busy={pending}
          disabled={!hydrated}
          onConfirm={() => void run(`/api/v1/receipts/${id}`, "DELETE", t.deleted)}
        />
      </div>
      <Alert>{error}</Alert>
      <Alert tone="ok">{info}</Alert>
    </div>
  );
}
