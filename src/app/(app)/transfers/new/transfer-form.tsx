"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { Field } from "@/components/ledger/field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { ro } from "@/messages/ro";

import { goToLogin } from "../../../_lib/api-client";
import {
  type FormErrors,
  NO_ERRORS,
  apiErrors,
  asCurrency,
  parseAmountInput,
} from "../../../_lib/ledger-ui";
import { useHydrated } from "../../../_lib/use-hydrated";
import { useSubmit } from "../../../_lib/use-submit";

type AccountOption = Readonly<{ id: string; name: string; currency: string }>;

/**
 * Transferul între două conturi ale gospodăriei (`POST /api/v1/transfers`, cu
 * `Idempotency-Key`). Aceeași monedă → o singură sumă (`amountMinor`); monede diferite → ambele
 * sume, scrise de utilizator (`amountFromMinor`, `amountToMinor`), fără curs implicit.
 */
export function TransferForm({
  accounts,
  today,
}: Readonly<{ accounts: readonly AccountOption[]; today: string }>) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [fromId, setFromId] = useState(accounts[0]?.id ?? "");
  const [toId, setToId] = useState(accounts[1]?.id ?? "");
  const fromCurrency = asCurrency(accounts.find((a) => a.id === fromId)?.currency ?? "RON");
  const toCurrency = asCurrency(accounts.find((a) => a.id === toId)?.currency ?? "RON");
  const twoAmounts = fromCurrency !== toCurrency;
  const t = ro.transfers;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const fields: Record<string, string> = {};
    if (fromId === toId) fields.toAccountId = t.sameAccount;
    const occurredOn = String(form.get("occurredOn") ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) fields.occurredOn = ro.ledger.errors.invalid;
    const amounts: Record<string, number> = {};
    if (twoAmounts) {
      const from = parseAmountInput(String(form.get("amountFrom") ?? ""), fromCurrency, {
        positive: true,
      });
      const to = parseAmountInput(String(form.get("amountTo") ?? ""), toCurrency, {
        positive: true,
      });
      if (from.ok) amounts.amountFromMinor = from.amountMinor;
      else fields.amountFrom = from.message;
      if (to.ok) amounts.amountToMinor = to.amountMinor;
      else fields.amountTo = to.message;
    } else {
      const one = parseAmountInput(String(form.get("amount") ?? ""), fromCurrency, {
        positive: true,
      });
      if (one.ok) amounts.amountMinor = one.amountMinor;
      else fields.amount = one.message;
    }
    if (Object.keys(fields).length > 0) {
      setErrors({ form: ro.ledger.errors.invalid, fields });
      return;
    }
    setErrors(NO_ERRORS);
    const description = String(form.get("description") ?? "").trim() || null;
    const result = await submit(
      "/api/v1/transfers",
      "POST",
      { fromAccountId: fromId, toAccountId: toId, ...amounts, occurredOn, description },
      { idempotent: true, lockOnSuccess: true },
    );
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      const mapped = apiErrors(result);
      const f: Record<string, string> = { ...mapped.fields };
      if (f.amountMinor) f.amount = f.amountMinor;
      if (f.amountFromMinor) f.amountFrom = f.amountFromMinor;
      if (f.amountToMinor) f.amountTo = f.amountToMinor;
      setErrors({ form: mapped.form, fields: f });
      return;
    }
    router.push("/transactions");
    router.refresh();
  }

  const options = accounts.map((a) => (
    <option key={a.id} value={a.id}>
      {a.name} ({a.currency})
    </option>
  ));
  return (
    <Card>
      <form method="post" onSubmit={onSubmit} noValidate aria-busy={pending}>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id="transfer-from" label={t.from} error={errors.fields.fromAccountId}>
              {(p) => (
                <Select
                  id={p.id}
                  name="fromAccountId"
                  value={fromId}
                  onChange={(e) => setFromId(e.target.value)}
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                >
                  {options}
                </Select>
              )}
            </Field>
            <Field id="transfer-to" label={t.to} error={errors.fields.toAccountId}>
              {(p) => (
                <Select
                  id={p.id}
                  name="toAccountId"
                  value={toId}
                  onChange={(e) => setToId(e.target.value)}
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                >
                  {options}
                </Select>
              )}
            </Field>
            {twoAmounts ? (
              <>
                <p className="text-sm text-muted-foreground sm:col-span-2">{t.twoCurrencies}</p>
                <Field
                  id="transfer-amount-from"
                  label={t.amountFrom(fromCurrency)}
                  hint={ro.ledger.amountHint}
                  error={errors.fields.amountFrom}
                >
                  {(p) => (
                    <Input
                      id={p.id}
                      name="amountFrom"
                      inputMode="decimal"
                      autoComplete="off"
                      aria-describedby={p.describedBy}
                      aria-invalid={p.invalid || undefined}
                    />
                  )}
                </Field>
                <Field
                  id="transfer-amount-to"
                  label={t.amountTo(toCurrency)}
                  hint={ro.ledger.amountHint}
                  error={errors.fields.amountTo}
                >
                  {(p) => (
                    <Input
                      id={p.id}
                      name="amountTo"
                      inputMode="decimal"
                      autoComplete="off"
                      aria-describedby={p.describedBy}
                      aria-invalid={p.invalid || undefined}
                    />
                  )}
                </Field>
              </>
            ) : (
              <Field
                id="transfer-amount"
                label={`${t.amount} (${fromCurrency})`}
                hint={ro.ledger.amountHint}
                error={errors.fields.amount}
              >
                {(p) => (
                  <Input
                    id={p.id}
                    name="amount"
                    inputMode="decimal"
                    autoComplete="off"
                    aria-describedby={p.describedBy}
                    aria-invalid={p.invalid || undefined}
                  />
                )}
              </Field>
            )}
            <Field id="transfer-date" label={ro.transactions.date} error={errors.fields.occurredOn}>
              {(p) => (
                <Input
                  id={p.id}
                  name="occurredOn"
                  type="date"
                  defaultValue={today}
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                />
              )}
            </Field>
            <Field
              id="transfer-description"
              label={ro.transactions.description}
              optional={ro.ledger.optional}
              error={errors.fields.description}
            >
              {(p) => (
                <Input
                  id={p.id}
                  name="description"
                  maxLength={500}
                  autoComplete="off"
                  aria-describedby={p.describedBy}
                />
              )}
            </Field>
          </div>
          <Alert>{errors.form}</Alert>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending || !hydrated}>
              {pending ? ro.ledger.saving : t.create}
            </Button>
            <Button variant="ghost" onClick={() => router.push("/transactions")} disabled={pending}>
              {ro.ledger.cancel}
            </Button>
          </div>
        </CardContent>
      </form>
    </Card>
  );
}
