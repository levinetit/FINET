"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { ConfirmButton } from "@/components/ledger/confirm-button";
import { Field } from "@/components/ledger/field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { ro } from "@/messages/ro";
import type { RecurringRuleJson } from "@/modules/recurring/recurring.schema";

import { goToLogin } from "../../_lib/api-client";
import {
  type FormErrors,
  NO_ERRORS,
  amountInputValue,
  apiErrors,
  asCurrency,
} from "../../_lib/ledger-ui";
import {
  RECURRING_LIMITS,
  UI_RECURRING_FREQUENCIES,
  UI_RECURRING_TYPES,
  recurringFormBody,
  usesDayOfMonth,
} from "../../_lib/recurring-ui";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

export type RecurringAccountOption = Readonly<{ id: string; name: string; currency: string }>;
export type RecurringCategoryOption = Readonly<{ id: string; name: string; kind: string }>;

/** Numele câmpurilor API → câmpurile formularului (pentru erorile întoarse de server). */
const API_FIELD: Readonly<Record<string, string>> = {
  amountMinor: "amount",
  amount: "amount",
};

/**
 * Regula recurentă: creare (`POST /api/v1/recurring`, cu `Idempotency-Key`) sau editare (`PATCH`;
 * tipul și data de început nu se schimbă după creare) și ștergere cu confirmare. Validarea din
 * browser are aceleași limite ca serverul (descriere obligatorie, interval ≤ 100, rate ≤ 1200,
 * ziua din lună doar la lunar/anual); suma se scrie `0,00` în moneda contului ales.
 */
export function RecurringForm({
  rule,
  accounts,
  categories,
  today,
}: Readonly<{
  rule?: RecurringRuleJson;
  accounts: readonly RecurringAccountOption[];
  categories: readonly RecurringCategoryOption[];
  today: string;
}>) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [type, setType] = useState<string>(rule?.type ?? "expense");
  const [accountId, setAccountId] = useState(rule?.accountId ?? accounts[0]?.id ?? "");
  const [frequency, setFrequency] = useState<string>(rule?.frequency ?? "monthly");
  const t = ro.recurring;
  const account = accounts.find((a) => a.id === accountId);
  const currency = asCurrency(account?.currency ?? rule?.currency ?? "RON");
  const kindCategories = categories.filter((c) => c.kind === type);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "");
    const parsed = recurringFormBody(
      {
        description: text("description"),
        merchant: text("merchant"),
        type,
        accountId,
        categoryId: text("categoryId"),
        amount: text("amount"),
        frequency,
        interval: text("interval"),
        dayOfMonth: text("dayOfMonth"),
        startOn: rule ? rule.startOn : text("startOn"),
        endOn: text("endOn"),
        maxOccurrences: text("maxOccurrences"),
      },
      currency,
      rule ? "edit" : "create",
    );
    if (!parsed.ok) {
      setErrors({ form: ro.ledger.errors.invalid, fields: parsed.fields });
      return;
    }
    setErrors(NO_ERRORS);
    const result = rule
      ? await submit(`/api/v1/recurring/${rule.id}`, "PATCH", parsed.body, { lockOnSuccess: true })
      : await submit("/api/v1/recurring", "POST", parsed.body, {
          idempotent: true,
          lockOnSuccess: true,
        });
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      const mapped = apiErrors(result);
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(mapped.fields)) fields[API_FIELD[k] ?? k] = v;
      setErrors({ form: mapped.form, fields });
      return;
    }
    router.push(rule ? `/recurring/${rule.id}` : "/recurring");
    router.refresh();
  }

  async function remove() {
    if (!rule) return;
    const result = await submit(`/api/v1/recurring/${rule.id}`, "DELETE", undefined, {
      lockOnSuccess: true,
    });
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setErrors({ form: apiErrors(result).form, fields: {} });
      return;
    }
    router.push("/recurring");
    router.refresh();
  }

  const busy = pending || !hydrated;
  const f = errors.fields;
  return (
    <Card>
      <form method="post" onSubmit={onSubmit} noValidate aria-busy={pending}>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              id="recurring-description"
              label={t.description}
              hint={t.descriptionHint}
              error={f.description}
            >
              {(p) => (
                <Input
                  id={p.id}
                  name="description"
                  maxLength={RECURRING_LIMITS.description}
                  autoComplete="off"
                  required
                  defaultValue={rule?.description ?? ""}
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                />
              )}
            </Field>
            <Field
              id="recurring-type"
              label={t.type}
              hint={rule ? t.typeLocked : undefined}
              error={f.type}
            >
              {(p) => (
                <Select
                  id={p.id}
                  name="type"
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  disabled={Boolean(rule)}
                  aria-describedby={p.describedBy}
                >
                  {UI_RECURRING_TYPES.map((v) => (
                    <option key={v} value={v}>
                      {ro.ledger.types[v]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field id="recurring-account" label={t.account} error={f.accountId}>
              {(p) => (
                <Select
                  id={p.id}
                  name="accountId"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  required
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.currency})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              id="recurring-category"
              label={t.category}
              optional={ro.ledger.optional}
              error={f.categoryId}
            >
              {(p) => (
                <Select
                  id={p.id}
                  name="categoryId"
                  defaultValue={rule?.categoryId ?? ""}
                  key={type}
                  aria-describedby={p.describedBy}
                >
                  <option value="">{t.noCategory}</option>
                  {kindCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              id="recurring-amount"
              label={`${t.amount} (${currency})`}
              hint={ro.ledger.amountHint}
              error={f.amount}
            >
              {(p) => (
                <Input
                  id={p.id}
                  name="amount"
                  inputMode="decimal"
                  autoComplete="off"
                  required
                  defaultValue={
                    rule ? amountInputValue(rule.amountMinor, asCurrency(rule.currency)) : ""
                  }
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                />
              )}
            </Field>
            <Field
              id="recurring-merchant"
              label={t.merchant}
              optional={ro.ledger.optional}
              error={f.merchant}
            >
              {(p) => (
                <Input
                  id={p.id}
                  name="merchant"
                  maxLength={RECURRING_LIMITS.merchant}
                  autoComplete="off"
                  defaultValue={rule?.merchant ?? ""}
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                />
              )}
            </Field>
            <Field id="recurring-frequency" label={t.frequency} error={f.frequency}>
              {(p) => (
                <Select
                  id={p.id}
                  name="frequency"
                  value={frequency}
                  onChange={(e) => setFrequency(e.target.value)}
                  aria-describedby={p.describedBy}
                >
                  {UI_RECURRING_FREQUENCIES.map((v) => (
                    <option key={v} value={v}>
                      {t.frequencies[v]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              id="recurring-interval"
              label={t.interval}
              hint={t.intervalHint}
              error={f.interval}
            >
              {(p) => (
                <Input
                  id={p.id}
                  name="interval"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={RECURRING_LIMITS.interval}
                  step={1}
                  defaultValue={String(rule?.interval ?? 1)}
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                />
              )}
            </Field>
            {usesDayOfMonth(frequency) ? (
              <Field
                id="recurring-day"
                label={t.dayOfMonth}
                optional={ro.ledger.optional}
                hint={t.dayOfMonthHint}
                error={f.dayOfMonth}
              >
                {(p) => (
                  <Input
                    id={p.id}
                    name="dayOfMonth"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={31}
                    step={1}
                    defaultValue={rule?.dayOfMonth === null ? "" : String(rule?.dayOfMonth ?? "")}
                    aria-describedby={p.describedBy}
                    aria-invalid={p.invalid || undefined}
                  />
                )}
              </Field>
            ) : null}
            <Field
              id="recurring-start"
              label={t.startOn}
              hint={rule ? t.startOnLocked : t.startOnHint}
              error={f.startOn}
            >
              {(p) => (
                <Input
                  id={p.id}
                  name="startOn"
                  type="date"
                  required
                  disabled={Boolean(rule)}
                  defaultValue={rule?.startOn ?? today}
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                />
              )}
            </Field>
            <Field id="recurring-end" label={t.endOn} optional={ro.ledger.optional} error={f.endOn}>
              {(p) => (
                <Input
                  id={p.id}
                  name="endOn"
                  type="date"
                  defaultValue={rule?.endOn ?? ""}
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                />
              )}
            </Field>
            <Field
              id="recurring-max"
              label={t.maxOccurrences}
              optional={ro.ledger.optional}
              hint={t.maxOccurrencesHint}
              error={f.maxOccurrences}
            >
              {(p) => (
                <Input
                  id={p.id}
                  name="maxOccurrences"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={RECURRING_LIMITS.maxOccurrences}
                  step={1}
                  defaultValue={
                    rule?.maxOccurrences === null ? "" : String(rule?.maxOccurrences ?? "")
                  }
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                />
              )}
            </Field>
          </div>
          <Alert>{errors.form}</Alert>
          <div className="flex flex-wrap items-start gap-2">
            <Button type="submit" disabled={busy}>
              {pending ? ro.ledger.saving : ro.ledger.save}
            </Button>
            <Button
              variant="ghost"
              onClick={() => router.push(rule ? `/recurring/${rule.id}` : "/recurring")}
              disabled={pending}
            >
              {ro.ledger.cancel}
            </Button>
            {rule ? (
              <ConfirmButton
                label={ro.ledger.delete}
                question={t.deleteConfirm}
                busy={busy}
                onConfirm={() => void remove()}
              />
            ) : null}
          </div>
        </CardContent>
      </form>
    </Card>
  );
}
