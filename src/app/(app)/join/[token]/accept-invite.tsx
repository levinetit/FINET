"use client";

import Link from "next/link";
import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ro } from "@/messages/ro";

import { goToLogin } from "../../../_lib/api-client";
import { apiErrors } from "../../../_lib/ledger-ui";
import { useHydrated } from "../../../_lib/use-hydrated";
import { useSubmit } from "../../../_lib/use-submit";

type AcceptResult = { householdId: string; joined: boolean };

/**
 * Butonul „Acceptă invitația” (`POST /api/v1/invites/accept`, tokenul în corp). Orice invitație
 * inutilizabilă dă același mesaj (serverul răspunde uniform 404); 429 → mesajul cu minutele.
 */
export function AcceptInvite({ token }: Readonly<{ token: string }>) {
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const t = ro.join;

  async function accept() {
    setError(null);
    const result = await submit<AcceptResult>(
      "/api/v1/invites/accept",
      "POST",
      { token },
      {
        lockOnSuccess: true,
      },
    );
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (result.ok && result.data) {
      setDone(result.data.joined ? t.joined : t.alreadyMember);
      return;
    }
    if (result.status === 404) setError(t.unavailable);
    else if (result.status === 429)
      setError(t.rateLimited(Math.max(1, Math.ceil((result.retryAfter ?? 60) / 60))));
    else if (result.status === 409 && result.error?.reason === "household_full") setError(t.full);
    else setError(apiErrors(result).form);
  }

  return (
    <Card>
      <CardContent>
        <p>{t.intro}</p>
        {done ? (
          <>
            <Alert tone="ok" data-testid="join-result">
              {done}
            </Alert>
            <div>
              {/* Pagină completă: gospodăria activă s-a schimbat. */}
              <a href="/family" className={buttonClasses()} data-testid="join-go-family">
                {t.goFamily}
              </a>
            </div>
          </>
        ) : (
          <div>
            <Button
              onClick={() => void accept()}
              disabled={pending || !hydrated || token === ""}
              data-testid="join-accept"
            >
              {pending ? t.accepting : t.accept}
            </Button>
          </div>
        )}
        <Alert data-testid="join-error">{error}</Alert>
        {error ? (
          <p className="text-sm">
            <Link href="/dashboard" className="underline">
              {ro.common.backHome}
            </Link>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
