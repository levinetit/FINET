"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ro } from "@/messages/ro";

import { goToLogin } from "../../_lib/api-client";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

/**
 * Consimțământul `externalAiAsk` (F10-C, ADR 0026): fără el, textul întrebărilor „Întreabă FINET”
 * nu pleacă niciodată la un model extern, separat de acordul pentru pozele bonurilor.
 */
export function AskAiConsent({ granted }: Readonly<{ granted: boolean }>) {
  const t = ro.askAiConsent;
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [enabled, setEnabled] = useState(granted);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setError(null);
    setInfo(null);
    const result = await submit("/api/v1/me/consents", "PUT", { externalAiAsk: next });
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(ro.usage.error);
      return;
    }
    setEnabled(next);
    setInfo(next ? t.on : t.off);
    router.refresh();
  }

  return (
    <Card id="ask-ai" aria-labelledby="ask-ai-title">
      <CardHeader>
        <CardTitle id="ask-ai-title">{t.title}</CardTitle>
        <CardDescription id="ask-ai-info">{t.info}</CardDescription>
      </CardHeader>
      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          role="switch"
          className="size-5 accent-[var(--accent)]"
          checked={enabled}
          disabled={pending || !hydrated}
          aria-describedby="ask-ai-info"
          data-testid="ask-ai-toggle"
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span className="font-medium">{t.toggle}</span>
      </label>
      {pending ? <p className="mt-2 text-sm text-muted-foreground">{ro.usage.saving}</p> : null}
      <Alert className="mt-3">{error}</Alert>
      <Alert tone="ok" className="mt-3">
        {info}
      </Alert>
    </Card>
  );
}
