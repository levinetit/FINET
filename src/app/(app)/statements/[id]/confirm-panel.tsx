"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Currency } from "@/lib/money";
import { cn } from "@/lib/utils";
import { ro } from "@/messages/ro";

import { goToLogin } from "../../../_lib/api-client";
import { apiErrors, formatMinor } from "../../../_lib/ledger-ui";
import { formatDate } from "../../../_lib/planning-ui";
import { counterAmountMinor } from "../../../_lib/statements-ui";
import { useHydrated } from "../../../_lib/use-hydrated";
import { useSubmit } from "../../../_lib/use-submit";
import { StatementActions } from "../statement-actions";

type Line = Readonly<{
  rowNo: number;
  occurredOn: string;
  direction: "debit" | "credit";
  amountMinor: number;
  description: string;
  kind: "movement" | "fx";
  fxCurrency: string | null;
  fxAmountMinor: number | null;
  state: string;
}>;
type Other = Readonly<{ id: string; name: string; currency: string }>;
type Fx = { mode: "transfer" | "plain" | "skip"; account: string; amount: string };

/**
 * Previzualizarea confirmabilă (F7-B): tabelul rândurilor (duplicatele marcate și neselectabile),
 * excluderea rândurilor, decizia pentru fiecare schimb valutar și confirmarea cu `Idempotency-Key`
 * (aceeași cheie la reîncercarea aceluiași corp). La nepotrivirea soldurilor, confirmarea cere
 * bifa explicită.
 */
export function ConfirmPanel({
  id,
  currency,
  mismatch,
  lines,
  others,
}: Readonly<{
  id: string;
  currency: Currency;
  mismatch: boolean;
  lines: readonly Line[];
  others: readonly Other[];
}>) {
  const t = ro.statements;
  const ids = useId();
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [skip, setSkip] = useState<ReadonlySet<number>>(new Set());
  const [ack, setAck] = useState(false);
  const [fx, setFx] = useState<Record<number, Fx>>(() =>
    Object.fromEntries(
      lines
        .filter((l) => l.kind === "fx" && l.state === "new")
        .map((l) => [
          l.rowNo,
          {
            mode: others.some((o) => o.currency === l.fxCurrency) ? "transfer" : "skip",
            account: others.find((o) => !l.fxCurrency || o.currency === l.fxCurrency)?.id ?? "",
            amount: "",
          },
        ]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const fxLines = lines.filter((l) => l.kind === "fx" && l.state === "new");

  async function confirm() {
    setError(null);
    const decisions = fxLines.map((l) => {
      const d = fx[l.rowNo]!;
      if (d.mode !== "transfer") return { rowNo: l.rowNo, mode: d.mode };
      const other = others.find((o) => o.id === d.account);
      const counter =
        l.fxAmountMinor === null && other
          ? counterAmountMinor(d.amount, other.currency as Currency)
          : null;
      return {
        rowNo: l.rowNo,
        mode: d.mode,
        counterpartAccountId: d.account,
        ...(counter !== null ? { counterAmountMinor: counter } : {}),
      };
    });
    const body = {
      ...(mismatch ? { acknowledgeBalanceMismatch: ack } : {}),
      ...(skip.size ? { skipRows: [...skip].sort((a, b) => a - b) } : {}),
      ...(decisions.length ? { fx: decisions } : {}),
    };
    const result = await submit<{ importedCount: number }>(
      `/api/v1/statements/imports/${id}/confirm`,
      "POST",
      body,
      { idempotent: true },
    );
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(apiErrors(result).form);
      return;
    }
    setInfo(t.imported(result.data?.importedCount ?? 0));
    router.refresh();
  }

  return (
    <Card aria-labelledby={`${ids}-title`}>
      <CardHeader>
        <CardTitle id={`${ids}-title`}>{t.table.caption}</CardTitle>
      </CardHeader>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm" data-testid="statement-lines">
          <caption className="sr-only">{t.table.caption}</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col">{t.table.exclude}</th>
              <th scope="col">{t.table.date}</th>
              <th scope="col">{t.table.description}</th>
              <th scope="col" className="text-right">
                {t.table.amount}
              </th>
              <th scope="col">{t.table.state}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr
                key={l.rowNo}
                className={cn(
                  "border-b border-border",
                  l.state === "duplicate" && "text-muted-foreground",
                )}
                data-state={l.state}
              >
                <td>
                  {l.state === "new" ? (
                    <input
                      type="checkbox"
                      aria-label={`${t.table.exclude}: ${l.description}`}
                      checked={skip.has(l.rowNo)}
                      onChange={(e) => {
                        const next = new Set(skip);
                        if (e.target.checked) next.add(l.rowNo);
                        else next.delete(l.rowNo);
                        setSkip(next);
                      }}
                    />
                  ) : null}
                </td>
                <td className="whitespace-nowrap">{formatDate(l.occurredOn)}</td>
                <td>{l.description}</td>
                <td
                  className={cn(
                    "text-right whitespace-nowrap",
                    l.direction === "credit" && "text-ok",
                  )}
                >
                  {l.direction === "debit" ? "−" : "+"}
                  {formatMinor(l.amountMinor, currency)}
                </td>
                <td>
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-xs font-semibold",
                      l.state === "duplicate" ? "bg-warn-soft" : "bg-muted",
                    )}
                  >
                    {t.lineStates[l.state]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {fxLines.length ? (
        <fieldset className="mt-4 flex flex-col gap-3" data-testid="statement-fx">
          <legend className="font-semibold">{t.fxTitle}</legend>
          <CardDescription>{t.fxHint}</CardDescription>
          {fxLines.map((l) => {
            const d = fx[l.rowNo]!;
            const set = (p: Partial<Fx>) => setFx({ ...fx, [l.rowNo]: { ...d, ...p } });
            const other = others.find((o) => o.id === d.account);
            return (
              <div
                key={l.rowNo}
                className="flex flex-col gap-2 rounded-md border border-border p-3"
              >
                <label className="flex flex-col gap-1 text-sm font-medium">
                  {t.fxMode(l.rowNo)} ({formatMinor(l.amountMinor, currency)})
                  <select
                    className="h-11 rounded-md border border-border bg-card px-3"
                    value={d.mode}
                    onChange={(e) => set({ mode: e.target.value as Fx["mode"] })}
                  >
                    {(["transfer", "plain", "skip"] as const).map((m) => (
                      <option key={m} value={m} disabled={m === "transfer" && others.length === 0}>
                        {t.fxModes[m]}
                      </option>
                    ))}
                  </select>
                </label>
                {d.mode === "transfer" ? (
                  <>
                    <label className="flex flex-col gap-1 text-sm font-medium">
                      {t.fxAccount}
                      <select
                        className="h-11 rounded-md border border-border bg-card px-3"
                        value={d.account}
                        onChange={(e) => set({ account: e.target.value })}
                      >
                        {others.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name} ({o.currency})
                          </option>
                        ))}
                      </select>
                    </label>
                    {l.fxAmountMinor === null && other ? (
                      <label className="flex flex-col gap-1 text-sm font-medium">
                        {t.fxAmount(other.currency)}
                        <input
                          inputMode="decimal"
                          className="h-11 rounded-md border border-border bg-card px-3"
                          value={d.amount}
                          onChange={(e) => set({ amount: e.target.value })}
                        />
                      </label>
                    ) : null}
                  </>
                ) : null}
              </div>
            );
          })}
        </fieldset>
      ) : null}

      {mismatch ? (
        <label className="mt-4 flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            data-testid="statement-ack"
          />
          {t.acknowledge}
        </label>
      ) : null}

      <div className="mt-4 flex flex-wrap items-start gap-3">
        <Button
          disabled={!hydrated || pending || (mismatch && !ack)}
          onClick={() => void confirm()}
          data-testid="statement-confirm"
        >
          {pending ? t.confirming : t.confirm}
        </Button>
        <StatementActions id={id} status="previewed" />
      </div>
      <Alert className="mt-2">{error}</Alert>
      <Alert tone="ok" className="mt-2" data-testid="statement-confirmed">
        {info}
      </Alert>
    </Card>
  );
}
