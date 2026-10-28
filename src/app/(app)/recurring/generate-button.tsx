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

type GenerateResult = { generated: number; failed: number };

/**
 * „Generează scadentele” (`POST /api/v1/recurring/generate`), MEREU cu `Idempotency-Key`
 * (obligatoriu pe server): o cheie nouă per apăsare, păstrată doar la reîncercarea după o eroare de
 * rețea/5xx (`use-submit`). Generarea e idempotentă pe scadență, deci o a doua apăsare creează 0.
 * Rezultatul se anunță într-o regiune `aria-live`.
 */
export function GenerateButton() {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = ro.recurring;

  async function run() {
    setInfo(null);
    setError(null);
    const result = await submit<GenerateResult>(
      "/api/v1/recurring/generate",
      "POST",
      {},
      { idempotent: true },
    );
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok || !result.data) {
      setError(apiErrors(result).form);
      return;
    }
    const { generated, failed } = result.data;
    setInfo(
      failed > 0
        ? `${t.generated(generated)} ${t.generatedFailed(failed)}`
        : t.generated(generated),
    );
    router.refresh();
  }

  return (
    <div className="flex max-w-md flex-col gap-2">
      <div>
        <Button
          onClick={() => void run()}
          disabled={pending || !hydrated}
          aria-describedby="recurring-generate-hint"
          data-testid="recurring-generate"
        >
          {pending ? t.generating : t.generate}
        </Button>
      </div>
      <p id="recurring-generate-hint" className="text-sm text-muted-foreground">
        {t.generateHint}
      </p>
      <Alert tone="ok" data-testid="recurring-generate-result">
        {info}
      </Alert>
      <Alert>{error}</Alert>
    </div>
  );
}
