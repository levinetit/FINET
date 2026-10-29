"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { ConfirmButton } from "@/components/ledger/confirm-button";
import { Field } from "@/components/ledger/field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import type { Currency } from "@/lib/money";
import { ro } from "@/messages/ro";

import { goToLogin } from "../../_lib/api-client";
import {
  type FormErrors,
  NO_ERRORS,
  amountInputValue,
  apiErrors,
  asCurrency,
  parseAmountInput,
} from "../../_lib/ledger-ui";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

type Pair = Readonly<{
  debtorUserId: string;
  creditorUserId: string;
  amountMinor: number;
  currency: Currency;
}>;

/**
 * Înregistrarea unei decontări (`POST /api/v1/family/settlements`, cu `Idempotency-Key`). Implicit:
 * tu → cel căruia îi datorezi, cu soldul întreg (o sumă mai mică = decontare parțială). Un member
 * alege doar decontări în care e parte (serverul verifică oricum: 403); suma nu poate depăși
 * datoria (409 `settlement_exceeds_debt`).
 */
export function SettlementForm({
  members,
  meUserId,
  currencies,
  suggestion,
  today,
}: Readonly<{
  members: readonly Readonly<{ userId: string; name: string }>[];
  meUserId: string;
  /** Un owner poate înregistra decontarea pentru oricare doi membri. */
  isOwner: boolean;
  currencies: readonly Currency[];
  suggestion: Pair | null;
  today: string;
}>) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [info, setInfo] = useState<string | null>(null);
  const t = ro.family;
  const other = members.find((m) => m.userId !== meUserId)?.userId ?? "";
  const defaultFrom = suggestion?.debtorUserId ?? meUserId;
  const defaultTo = suggestion?.creditorUserId ?? other;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const fromUserId = String(form.get("fromUserId") ?? "");
    const toUserId = String(form.get("toUserId") ?? "");
    const currency = asCurrency(String(form.get("currency") ?? "RON"));
    const fields: Record<string, string> = {};
    const amount = parseAmountInput(String(form.get("amount") ?? ""), currency, {
      positive: true,
    });
    if (!amount.ok) fields.amount = amount.message;
    if (fromUserId === toUserId) fields.toUserId = ro.ledger.errors.invalid;
    if (Object.keys(fields).length > 0 || !amount.ok) {
      setErrors({ form: ro.ledger.errors.invalid, fields });
      return;
    }
    setErrors(NO_ERRORS);
    setInfo(null);
    const note = String(form.get("note") ?? "").trim();
    const result = await submit(
      "/api/v1/family/settlements",
      "POST",
      {
        fromUserId,
        toUserId,
        amountMinor: amount.amountMinor,
        currency,
        settledOn: String(form.get("settledOn") ?? today),
        ...(note ? { note } : {}),
      },
      { idempotent: true },
    );
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      const mapped = apiErrors(result);
      const f: Record<string, string> = { ...mapped.fields };
      if (f.amountMinor) f.amount = f.amountMinor;
      setErrors({ form: mapped.form, fields: f });
      return;
    }
    formEl.reset();
    setInfo(t.settlementSaved);
    router.refresh();
  }

  const busy = pending || !hydrated;
  return (
    <form
      method="post"
      onSubmit={onSubmit}
      noValidate
      aria-busy={pending}
      className="flex flex-col gap-3"
      data-testid="settlement-form"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id="settlement-from" label={t.settlementFrom} error={errors.fields.fromUserId}>
          {(p) => (
            <Select
              id={p.id}
              name="fromUserId"
              defaultValue={defaultFrom}
              aria-describedby={p.describedBy}
            >
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="settlement-to" label={t.settlementTo} error={errors.fields.toUserId}>
          {(p) => (
            <Select
              id={p.id}
              name="toUserId"
              defaultValue={defaultTo}
              aria-describedby={p.describedBy}
            >
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          id="settlement-amount"
          label={t.settlementAmount}
          hint={ro.ledger.amountHint}
          error={errors.fields.amount}
        >
          {(p) => (
            <Input
              id={p.id}
              name="amount"
              inputMode="decimal"
              autoComplete="off"
              defaultValue={
                suggestion ? amountInputValue(suggestion.amountMinor, suggestion.currency) : ""
              }
              aria-describedby={p.describedBy}
              aria-invalid={p.invalid || undefined}
            />
          )}
        </Field>
        <Field id="settlement-currency" label={t.settlementCurrency} error={errors.fields.currency}>
          {(p) => (
            <Select
              id={p.id}
              name="currency"
              defaultValue={suggestion?.currency ?? currencies[0]}
              aria-describedby={p.describedBy}
            >
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="settlement-date" label={t.settlementDate} error={errors.fields.settledOn}>
          {(p) => (
            <Input
              id={p.id}
              name="settledOn"
              type="date"
              defaultValue={today}
              max={today}
              aria-describedby={p.describedBy}
            />
          )}
        </Field>
        <Field
          id="settlement-note"
          label={t.settlementNote}
          optional={ro.ledger.optional}
          error={errors.fields.note}
        >
          {(p) => (
            <Input
              id={p.id}
              name="note"
              maxLength={200}
              autoComplete="off"
              aria-describedby={p.describedBy}
            />
          )}
        </Field>
      </div>
      <Alert>{errors.form}</Alert>
      <Alert tone="ok" data-testid="settlement-result">
        {info}
      </Alert>
      <div>
        <Button type="submit" disabled={busy} data-testid="settlement-submit">
          {pending ? t.addingSettlement : t.addSettlement}
        </Button>
      </div>
    </form>
  );
}

/** Anularea unei decontări (oricare dintre părți sau creatorul; definitivă, istoricul rămâne). */
export function SettlementCancel({ id }: Readonly<{ id: string }>) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [error, setError] = useState<string | null>(null);
  const t = ro.family;

  async function cancel() {
    const result = await submit(`/api/v1/family/settlements/${id}/cancel`, "POST");
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(apiErrors(result).form);
      return;
    }
    router.refresh();
  }

  return (
    <span className="flex flex-col gap-1">
      <ConfirmButton
        label={t.cancelSettlement}
        question={t.cancelSettlementConfirm}
        confirmLabel={t.cancelSettlementYes}
        busy={pending || !hydrated}
        onConfirm={() => void cancel()}
      />
      <Alert>{error}</Alert>
    </span>
  );
}
