"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ro } from "@/messages/ro";

import { goToLogin } from "../../_lib/api-client";
import { apiErrors } from "../../_lib/ledger-ui";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

/**
 * Acceptarea (o regulă nouă, cu `Idempotency-Key`) sau respingerea unei propuneri de plată
 * recurentă (F7-B; ADR 0019). Serverul recalculează propunerea: clientul trimite doar amprenta.
 */
export function SuggestionActions({ signature }: Readonly<{ signature: string }>) {
  const t = ro.suggestions;
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function run(action: "accept" | "dismiss") {
    setError(null);
    const result = await submit<{ id: string }>(
      `/api/v1/recurring/suggestions/${signature}/${action}`,
      "POST",
      {},
      { idempotent: action === "accept", lockOnSuccess: action === "accept" },
    );
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(apiErrors(result).form);
      return;
    }
    // Acceptarea deschide regula creată (rândul propunerii dispare la reîncărcare, cu tot cu un
    // mesaj afișat aici); respingerea doar reîncarcă lista.
    const ruleId = (result.data as { id?: string } | null)?.id;
    if (action === "accept" && ruleId) {
      router.push(`/recurring/${ruleId}`);
      return;
    }
    setInfo(action === "accept" ? t.accepted : t.dismissed);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!hydrated || pending}
          onClick={() => void run("accept")}
          data-testid="suggestion-accept"
        >
          {t.accept}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!hydrated || pending}
          onClick={() => void run("dismiss")}
          data-testid="suggestion-dismiss"
        >
          {t.dismiss}
        </Button>
      </div>
      <Alert>{error}</Alert>
      <Alert tone="ok">{info}</Alert>
    </div>
  );
}
