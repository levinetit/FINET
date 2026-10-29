"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { Currency } from "@/lib/money";
import { ro } from "@/messages/ro";

import { goToLogin } from "../../_lib/api-client";
import { apiErrors, formatMinor } from "../../_lib/ledger-ui";
import { formatDate } from "../../_lib/planning-ui";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

export type MatchCandidateJson = Readonly<{
  transactionId: string;
  occurredOn: string;
  amountMinor: number;
  currency: string;
  description: string | null;
  score: number;
  probable: boolean;
  reasons: readonly string[];
}>;

/**
 * Propunerile de potrivire pentru un bon (F7-B; ADR 0019): fiecare tranzacție din extras cu scorul
 * și motivele (text, nu doar culoare), marcajul „ambiguu” și decizia utilizatorului (confirmă →
 * bonul se leagă, fără tranzacție nouă; respinge → nu se mai propune).
 */
export function MatchPanel({
  receiptId,
  ambiguous,
  candidates,
}: Readonly<{ receiptId: string; ambiguous: boolean; candidates: readonly MatchCandidateJson[] }>) {
  const t = ro.matching;
  const ids = useId();
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function decide(transactionId: string, decision: "confirm" | "reject") {
    setError(null);
    setInfo(null);
    const result = await submit(`/api/v1/receipts/${receiptId}/matches`, "POST", {
      transactionId,
      decision,
    });
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(apiErrors(result).form);
      return;
    }
    setInfo(decision === "confirm" ? t.confirmed : t.rejected);
    router.refresh();
  }

  return (
    <section
      aria-labelledby={`${ids}-title`}
      className="flex flex-col gap-2"
      data-testid="match-panel"
    >
      <h2 id={`${ids}-title`} className="font-semibold">
        {t.panel}
      </h2>
      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.none}</p>
      ) : (
        <>
          {ambiguous ? (
            <Alert tone="info" data-testid="match-ambiguous">
              {t.ambiguous}
            </Alert>
          ) : null}
          <ul className="flex flex-col gap-2">
            {candidates.map((c) => (
              <li
                key={c.transactionId}
                className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border p-3"
                data-testid="match-candidate"
              >
                <div className="flex flex-col gap-1 text-sm">
                  <span className="font-semibold">
                    {formatDate(c.occurredOn)} ·{" "}
                    {formatMinor(c.amountMinor, c.currency as Currency)}
                  </span>
                  <span>{c.description ?? "—"}</span>
                  <span className="text-muted-foreground">
                    {c.probable ? `${t.probable} · ` : ""}
                    {t.score(c.score)} ·{" "}
                    {c.reasons
                      .map((r) => t.reasons[r] ?? "")
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={!hydrated || pending}
                    onClick={() => void decide(c.transactionId, "confirm")}
                    data-testid="match-confirm"
                  >
                    {t.confirm}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!hydrated || pending}
                    onClick={() => void decide(c.transactionId, "reject")}
                    data-testid="match-reject"
                  >
                    {t.reject}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <Alert>{error}</Alert>
      <Alert tone="ok" data-testid="match-result">
        {info}
      </Alert>
    </section>
  );
}
