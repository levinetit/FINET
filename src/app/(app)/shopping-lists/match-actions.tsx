"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { ro } from "@/messages/ro";

import { goToLogin } from "../../_lib/api-client";
import { apiErrors } from "../../_lib/ledger-ui";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

type Action =
  | { action: "confirm" }
  | { action: "reject" }
  | { action: "clear" }
  | { action: "set"; receiptLineId: string };

/** Trimite acțiunea asupra potrivirii unui articol și reîncarcă ecranul. */
function useMatchAction(listId: string, itemId: string) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [error, setError] = useState<string | null>(null);
  async function send(body: Action) {
    setError(null);
    const result = await submit(
      `/api/v1/shopping-lists/${listId}/items/${itemId}/match`,
      "POST",
      body,
    );
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(apiErrors(result).form);
      return;
    }
    router.refresh();
  }
  return { send, busy: pending || !hydrated, error };
}

/** Confirmă / respinge propunerea sau desface o confirmare. */
export function MatchDecision({
  listId,
  itemId,
  itemName,
  confirmed,
}: Readonly<{ listId: string; itemId: string; itemName: string; confirmed: boolean }>) {
  const t = ro.shopping;
  const { send, busy, error } = useMatchAction(listId, itemId);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {confirmed ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            aria-label={`${t.unlink}: ${itemName}`}
            onClick={() => void send({ action: "clear" })}
          >
            {t.unlink}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              disabled={busy}
              aria-label={`${t.confirm}: ${itemName}`}
              onClick={() => void send({ action: "confirm" })}
              data-testid="match-confirm"
            >
              {t.confirm}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              aria-label={`${t.reject}: ${itemName}`}
              onClick={() => void send({ action: "reject" })}
              data-testid="match-reject"
            >
              {t.reject}
            </Button>
          </>
        )}
      </div>
      <Alert>{error}</Alert>
    </div>
  );
}

/** Corecția manuală: leagă articolul de o linie a bonului. */
export function LinkToLine({
  listId,
  itemId,
  itemName,
  lines,
}: Readonly<{
  listId: string;
  itemId: string;
  itemName: string;
  lines: readonly { id: string; name: string }[];
}>) {
  const t = ro.shopping;
  const { send, busy, error } = useMatchAction(listId, itemId);
  const [line, setLine] = useState("");
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={line}
          onChange={(e) => setLine(e.target.value)}
          aria-label={`${t.chooseLine}: ${itemName}`}
          className="max-w-64"
          data-testid="link-select"
        >
          <option value="">{t.chooseLinePlaceholder}</option>
          {lines.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !line}
          aria-label={`${t.link}: ${itemName}`}
          onClick={() => void send({ action: "set", receiptLineId: line })}
          data-testid="link-submit"
        >
          {t.link}
        </Button>
      </div>
      <Alert>{error}</Alert>
    </div>
  );
}
