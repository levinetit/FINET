"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { ConfirmButton } from "@/components/ledger/confirm-button";
import { Field } from "@/components/ledger/field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ro } from "@/messages/ro";
import type { GoalJson } from "@/modules/goals/goals.schema";

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

/**
 * Acțiunile pe loc ale unui obiectiv (pagina rămâne deschisă, deci fără `lockOnSuccess`):
 * contribuția (`POST …/contributions` cu `Idempotency-Key` MEREU — obligatoriu pe server; o cheie
 * nouă per acțiune, păstrată doar la reîncercarea aceluiași corp după rețea/5xx), abandonarea
 * (`POST …/abandon`, cu confirmare) și reluarea (`PATCH` cu `status: "active"`).
 */
export function GoalActions({ goal }: Readonly<{ goal: GoalJson }>) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [info, setInfo] = useState<string | null>(null);
  const busy = pending || !hydrated;
  const t = ro.goals;
  const currency = asCurrency(goal.currency);

  async function contribute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    // Butonul apăsat (Adaugă / Scade) dă direcția; Enter în câmp = primul buton (Adaugă).
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const direction = submitter?.getAttribute("value") === "withdraw" ? "withdraw" : "add";
    setInfo(null);
    const amount = parseAmountInput(String(new FormData(formEl).get("amount") ?? ""), currency, {
      positive: true,
    });
    if (!amount.ok) {
      setErrors({ form: null, fields: { amount: amount.message } });
      return;
    }
    setErrors(NO_ERRORS);
    const result = await submit(
      `/api/v1/goals/${goal.id}/contributions`,
      "POST",
      { direction, amountMinor: amount.amountMinor },
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
    setInfo(t.contributionDone);
    router.refresh();
  }

  async function changeStatus(abandon: boolean) {
    setInfo(null);
    setErrors(NO_ERRORS);
    const result = abandon
      ? await submit(`/api/v1/goals/${goal.id}/abandon`, "POST")
      : await submit(`/api/v1/goals/${goal.id}`, "PATCH", { status: "active" });
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setErrors({ form: apiErrors(result).form, fields: {} });
      return;
    }
    setInfo(abandon ? t.abandoned : t.resumed);
    router.refresh();
  }

  const abandoned = goal.status === "abandoned";
  return (
    <Card aria-labelledby="contribution-title">
      <CardHeader>
        <CardTitle id="contribution-title">{t.contributionTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        {abandoned ? null : (
          <form
            method="post"
            onSubmit={contribute}
            noValidate
            aria-busy={pending}
            className="flex flex-wrap items-end gap-2"
          >
            <Field
              id="goal-contribution"
              label={`${t.contributionAmount} (${goal.currency})`}
              error={errors.fields.amount}
              className="grow"
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
            <Button type="submit" name="direction" value="add" disabled={busy}>
              {t.addContribution}
            </Button>
            <Button
              type="submit"
              variant="outline"
              name="direction"
              value="withdraw"
              disabled={busy}
            >
              {t.withdraw}
            </Button>
          </form>
        )}
        <Alert>{errors.form}</Alert>
        <Alert tone="ok">{info}</Alert>
        <div>
          {abandoned ? (
            <Button variant="outline" disabled={busy} onClick={() => void changeStatus(false)}>
              {t.resume}
            </Button>
          ) : (
            <ConfirmButton
              label={t.abandon}
              question={t.abandonConfirm}
              confirmLabel={t.abandonYes}
              busy={busy}
              onConfirm={() => void changeStatus(true)}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
