"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { Alert } from "@/components/ui/alert";
import { ro } from "@/messages/ro";

/** Cât timp pasul AI e în lucru, ecranul se reîncarcă la 5 s (cel mult 3 minute). */
const POLL_MS = 5_000;
const MAX_POLLS = 36;

/**
 * Starea pasului OPȚIONAL cu LLM al comparației. Workerul nu publică evenimente live (rulează
 * într-un alt proces), deci cât timp cererea e `queued`/`processing` pagina se reîncarcă periodic,
 * doar cu fila vizibilă.
 */
export function AiStatus({ status }: Readonly<{ status: string }>) {
  const t = ro.shopping;
  const router = useRouter();
  const active = status === "queued" || status === "processing";
  useEffect(() => {
    if (!active) return;
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      if (polls > MAX_POLLS) {
        clearInterval(timer);
        return;
      }
      if (document.visibilityState === "visible") router.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, router]);
  if (status === "none" || status === "skipped") return null;
  const text = active ? t.aiQueued : status === "done" ? t.aiDone : t.aiFailed;
  return (
    <Alert tone="info" data-testid="ai-status" data-status={status}>
      {text} {t.aiNote}
    </Alert>
  );
}
