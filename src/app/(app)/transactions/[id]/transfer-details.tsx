"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConfirmButton } from "@/components/ledger/confirm-button";
import { Alert } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { ro } from "@/messages/ro";
import type { TransferJson } from "@/modules/transfers/transfers.schema";

import { goToLogin } from "../../../_lib/api-client";
import { apiErrors, formatCalendarDate, formatMinor } from "../../../_lib/ledger-ui";
import { useHydrated } from "../../../_lib/use-hydrated";
import { useSubmit } from "../../../_lib/use-submit";

/** Un transfer: cele două conturi și sumele lor; ștergerea elimină ambele rânduri. */
export function TransferDetails({
  transfer,
  fromName,
  toName,
}: Readonly<{ transfer: TransferJson; fromName: string; toName: string }>) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    const result = await submit(`/api/v1/transfers/${transfer.id}`, "DELETE", undefined, {
      lockOnSuccess: true,
    });
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(apiErrors(result).form);
      return;
    }
    router.push("/transactions");
    router.refresh();
  }

  return (
    <Card>
      <CardContent>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-muted-foreground">{ro.transfers.from}</dt>
            <dd className="font-semibold">{fromName}</dd>
            <dd className="font-mono tabular-nums" data-testid="transfer-from-amount">
              {formatMinor(transfer.from.amountMinor, transfer.from.currency)}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">{ro.transfers.to}</dt>
            <dd className="font-semibold">{toName}</dd>
            <dd className="font-mono tabular-nums" data-testid="transfer-to-amount">
              {formatMinor(transfer.to.amountMinor, transfer.to.currency)}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">{ro.transactions.date}</dt>
            <dd>{formatCalendarDate(transfer.occurredOn)}</dd>
          </div>
          {transfer.description ? (
            <div>
              <dt className="text-sm text-muted-foreground">{ro.transactions.description}</dt>
              <dd>{transfer.description}</dd>
            </div>
          ) : null}
        </dl>
        <Alert>{error}</Alert>
        <div>
          <ConfirmButton
            label={ro.transfers.deleteTransfer}
            question={ro.transfers.deleteConfirm}
            busy={pending || !hydrated}
            onConfirm={() => void remove()}
          />
        </div>
      </CardContent>
    </Card>
  );
}
