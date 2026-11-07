"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { ConfirmButton } from "@/components/ledger/confirm-button";
import { Field } from "@/components/ledger/field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { Currency } from "@/lib/money";
import { ro } from "@/messages/ro";
import type { ValuationJson } from "@/modules/net-worth/net-worth.schema";

import { goToLogin } from "../../../_lib/api-client";
import {
  type FormErrors,
  NO_ERRORS,
  apiErrors,
  formatMinor,
  parseAmountInput,
  todayIn,
} from "../../../_lib/ledger-ui";
import { formatDate } from "../../../_lib/planning-ui";
import { useHydrated } from "../../../_lib/use-hydrated";
import { useSubmit } from "../../../_lib/use-submit";

/**
 * Evaluările unui cont evaluat (ADR 0046): lista (cele mai noi primele), adăugarea (data + valoarea
 * semnată + notă) prin `POST /api/v1/accounts/{id}/valuations` cu `Idempotency-Key`, ștergerea cu
 * confirmare. Sumele trec doar prin `parseAmountInput`/`formatMinor` (money.ts).
 */
export function ValuationsPanel({
  accountId,
  currency,
  valuations,
}: Readonly<{ accountId: string; currency: Currency; valuations: readonly ValuationJson[] }>) {
  const t = ro.netWorth.valuations;
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [info, setInfo] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const valuedOn = String(data.get("valuedOn") ?? "");
    const valueText = String(data.get("value") ?? "").trim();
    const note = String(data.get("note") ?? "").trim();
    const parsed = parseAmountInput(valueText, currency, { allowNegative: true });
    if (!parsed.ok) {
      setErrors({ form: ro.ledger.errors.invalid, fields: { value: t.invalidValue } });
      return;
    }
    setErrors(NO_ERRORS);
    setInfo(null);
    const result = await submit<ValuationJson>(
      `/api/v1/accounts/${accountId}/valuations`,
      "POST",
      { valuedOn, valueMinor: parsed.amountMinor, ...(note ? { note } : {}) },
      { idempotent: true },
    );
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      const mapped = apiErrors(result);
      const f: Record<string, string> = { ...mapped.fields };
      if (f.valueMinor) f.value = f.valueMinor;
      if (result.error?.reason === "valuation_exists") f.valuedOn = t.exists;
      setErrors({ form: mapped.form, fields: f });
      return;
    }
    form.reset();
    setInfo(t.added);
    router.refresh();
  }

  async function remove(id: string) {
    setErrors(NO_ERRORS);
    setInfo(null);
    const result = await submit(`/api/v1/accounts/${accountId}/valuations/${id}`, "DELETE");
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setErrors(apiErrors(result));
      return;
    }
    setInfo(t.deleted);
    router.refresh();
  }

  return (
    <Card aria-labelledby="valuations-title" data-testid="valuations-panel">
      <CardHeader>
        <CardTitle id="valuations-title">{t.title}</CardTitle>
        <CardDescription>{t.hint}</CardDescription>
      </CardHeader>
      {errors.form ? <Alert className="mb-3">{errors.form}</Alert> : null}
      {info ? (
        <p className="mb-3 text-sm text-ok" role="status">
          {info}
        </p>
      ) : null}
      <form onSubmit={onSubmit} className="mb-4 grid gap-3 sm:grid-cols-3" noValidate>
        <Field id="valuation-date" label={t.date} error={errors.fields.valuedOn}>
          {(p) => (
            <Input
              id={p.id}
              name="valuedOn"
              type="date"
              required
              defaultValue={todayIn()}
              aria-describedby={p.describedBy}
              aria-invalid={p.invalid || undefined}
            />
          )}
        </Field>
        <Field id="valuation-value" label={t.value} hint={t.valueHint} error={errors.fields.value}>
          {(p) => (
            <Input
              id={p.id}
              name="value"
              inputMode="decimal"
              required
              placeholder="250.000"
              aria-describedby={p.describedBy}
              aria-invalid={p.invalid || undefined}
            />
          )}
        </Field>
        <Field
          id="valuation-note"
          label={t.note}
          optional={t.noteOptional}
          error={errors.fields.note}
        >
          {(p) => (
            <Input
              id={p.id}
              name="note"
              maxLength={200}
              aria-describedby={p.describedBy}
              aria-invalid={p.invalid || undefined}
            />
          )}
        </Field>
        <div className="sm:col-span-3">
          <Button type="submit" disabled={!hydrated || pending} data-testid="valuation-add">
            {pending ? t.adding : t.add}
          </Button>
        </div>
      </form>
      {valuations.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="valuations-empty">
          {t.empty}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border" data-testid="valuations-list">
          {valuations.map((v) => (
            <li
              key={v.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <span>
                {formatDate(v.valuedOn)}
                {v.note ? <span className="ml-2 text-muted-foreground">{v.note}</span> : null}
              </span>
              <span className="flex items-center gap-3">
                <span className="font-mono tabular-nums">
                  {formatMinor(v.valueMinor, currency)}
                </span>
                <ConfirmButton
                  label={t.delete}
                  question={t.deleteQuestion}
                  busy={pending}
                  disabled={!hydrated}
                  onConfirm={() => remove(v.id)}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
