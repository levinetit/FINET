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
import type { GoalJson } from "@/modules/goals/goals.schema";

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

export type GoalAccountOption = Readonly<{ id: string; name: string; currency: string }>;

const NAME_MAX = 100;

/**
 * Obiectivul: creare (`POST /api/v1/goals`) sau editare (`PATCH`: nume, țintă, termen, cont;
 * moneda nu se schimbă după creare) și ștergere cu confirmare. Contul e opțional și doar în
 * moneda obiectivului (cheia compusă din bază o cere oricum).
 */
export function GoalForm({
  goal,
  accounts,
  currencies,
  defaultCurrency,
}: Readonly<{
  goal?: GoalJson;
  accounts: readonly GoalAccountOption[];
  currencies: readonly string[];
  defaultCurrency: string;
}>) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [currency, setCurrency] = useState(goal?.currency ?? defaultCurrency);
  const [accountId, setAccountId] = useState(goal?.accountId ?? "");
  const matching = accounts.filter((a) => a.currency === currency);
  const t = ro.goals;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const fields: Record<string, string> = {};
    const name = String(form.get("name") ?? "").trim();
    if (name.length < 1 || name.length > NAME_MAX) fields.name = t.invalidName;
    const target = parseAmountInput(String(form.get("target") ?? ""), asCurrency(currency), {
      positive: true,
    });
    if (!target.ok) fields.target = target.message;
    const deadline = String(form.get("deadline") ?? "");
    if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline))
      fields.deadline = ro.ledger.errors.invalid;
    if (!target.ok || Object.keys(fields).length > 0) {
      setErrors({ form: ro.ledger.errors.invalid, fields });
      return;
    }
    setErrors(NO_ERRORS);
    const account = matching.some((a) => a.id === accountId) ? accountId : null;
    const common = {
      name,
      targetMinor: target.amountMinor,
      deadline: deadline || null,
      accountId: account,
    };
    const result = goal
      ? await submit(`/api/v1/goals/${goal.id}`, "PATCH", common, { lockOnSuccess: true })
      : await submit(
          "/api/v1/goals",
          "POST",
          { ...common, currency },
          { idempotent: true, lockOnSuccess: true },
        );
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      const mapped = apiErrors(result);
      const f: Record<string, string> = { ...mapped.fields };
      if (f.targetMinor) f.target = f.targetMinor;
      setErrors({ form: mapped.form, fields: f });
      return;
    }
    router.push(goal ? `/goals/${goal.id}` : "/goals");
    router.refresh();
  }

  async function remove() {
    if (!goal) return;
    const result = await submit(`/api/v1/goals/${goal.id}`, "DELETE", undefined, {
      lockOnSuccess: true,
    });
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setErrors({ form: apiErrors(result).form, fields: {} });
      return;
    }
    router.push("/goals");
    router.refresh();
  }

  const busy = pending || !hydrated;
  return (
    <Card>
      <form method="post" onSubmit={onSubmit} noValidate aria-busy={pending}>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id="goal-name" label={t.name} error={errors.fields.name}>
              {(p) => (
                <Input
                  id={p.id}
                  name="name"
                  maxLength={NAME_MAX}
                  autoComplete="off"
                  required
                  defaultValue={goal?.name ?? ""}
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                />
              )}
            </Field>
            <Field id="goal-currency" label={t.currency} error={errors.fields.currency}>
              {(p) => (
                <Select
                  id={p.id}
                  name="currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  disabled={Boolean(goal)}
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
            <Field
              id="goal-target"
              label={`${t.target} (${currency})`}
              hint={ro.ledger.amountHint}
              error={errors.fields.target}
            >
              {(p) => (
                <Input
                  id={p.id}
                  name="target"
                  inputMode="decimal"
                  autoComplete="off"
                  required
                  defaultValue={
                    goal ? amountInputValue(goal.targetMinor, asCurrency(goal.currency)) : ""
                  }
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                />
              )}
            </Field>
            <Field
              id="goal-deadline"
              label={t.deadline}
              optional={ro.ledger.optional}
              error={errors.fields.deadline}
            >
              {(p) => (
                <Input
                  id={p.id}
                  name="deadline"
                  type="date"
                  defaultValue={goal?.deadline ?? ""}
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                />
              )}
            </Field>
            <Field
              id="goal-account"
              label={t.account}
              hint={t.accountHint}
              error={errors.fields.accountId}
            >
              {(p) => (
                <Select
                  id={p.id}
                  name="accountId"
                  value={matching.some((a) => a.id === accountId) ? accountId : ""}
                  onChange={(e) => setAccountId(e.target.value)}
                  aria-describedby={p.describedBy}
                >
                  <option value="">{t.noAccount}</option>
                  {matching.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
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
              onClick={() => router.push(goal ? `/goals/${goal.id}` : "/goals")}
              disabled={pending}
            >
              {ro.ledger.cancel}
            </Button>
            {goal ? (
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
