"use client";

import { type FormEvent, useState } from "react";

import { Field } from "@/components/ledger/field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { ro } from "@/messages/ro";
import type { SavingsSimulationJson } from "@/modules/goals/plan.schema";

import { goToLogin } from "../../_lib/api-client";
import {
  type FormErrors,
  NO_ERRORS,
  apiErrors,
  asCurrency,
  formatMinor,
  parseAmountInput,
} from "../../_lib/ledger-ui";
import { formatDate } from "../../_lib/planning-ui";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

/**
 * Simulatorul planului de economisire (ADR 0047): ținta, cât ai deja, un termen și/sau o rată
 * lunară → `POST /api/v1/savings-plan/simulate` (fără scriere). Sumele doar prin money.ts.
 */
export function SavingsSimulator({ currencies }: Readonly<{ currencies: readonly string[] }>) {
  const t = ro.savings;
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [result, setResult] = useState<SavingsSimulationJson | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const currency = asCurrency(String(data.get("currency") ?? "RON"));
    const target = parseAmountInput(String(data.get("target") ?? ""), currency, { positive: true });
    const savedText = String(data.get("saved") ?? "").trim();
    const saved =
      savedText === ""
        ? { ok: true as const, amountMinor: 0 }
        : parseAmountInput(savedText, currency);
    const deadline = String(data.get("deadline") ?? "");
    const monthlyText = String(data.get("monthly") ?? "").trim();
    const monthly =
      monthlyText === "" ? null : parseAmountInput(monthlyText, currency, { positive: true });
    const fields: Record<string, string> = {};
    if (!target.ok) fields.target = t.invalidTarget;
    if (!saved.ok) fields.saved = saved.message;
    if (monthly && !monthly.ok) fields.monthly = t.invalidMonthly;
    if (!deadline && !monthly) fields.deadline = t.needOne;
    if (Object.keys(fields).length > 0 || !target.ok || !saved.ok) {
      setErrors({ form: ro.ledger.errors.invalid, fields });
      return;
    }
    setErrors(NO_ERRORS);
    const body: Record<string, unknown> = {
      currency,
      targetMinor: target.amountMinor,
      savedMinor: saved.amountMinor,
    };
    if (deadline) body.deadline = deadline;
    if (monthly && monthly.ok) body.monthlyMinor = monthly.amountMinor;
    const r = await submit<SavingsSimulationJson>("/api/v1/savings-plan/simulate", "POST", body);
    if (!r) return;
    if (r.status === 401) return goToLogin();
    if (!r.ok || !r.data) {
      setErrors(apiErrors(r));
      return;
    }
    setResult(r.data);
  }

  return (
    <Card aria-labelledby="savings-simulator" data-testid="savings-simulator">
      <CardHeader>
        <CardTitle id="savings-simulator">{t.simulateTitle}</CardTitle>
        <CardDescription>{t.simulateHint}</CardDescription>
      </CardHeader>
      {errors.form ? <Alert className="mb-3">{errors.form}</Alert> : null}
      <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
        <Field id="sim-target" label={t.target} error={errors.fields.target}>
          {(p) => (
            <Input
              id={p.id}
              name="target"
              inputMode="decimal"
              required
              placeholder="10.000"
              aria-describedby={p.describedBy}
              aria-invalid={p.invalid || undefined}
            />
          )}
        </Field>
        <Field id="sim-currency" label={t.currency}>
          {(p) => (
            <Select id={p.id} name="currency" defaultValue={currencies[0] ?? "RON"}>
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          id="sim-saved"
          label={t.saved}
          optional={ro.netWorth.valuations.noteOptional}
          error={errors.fields.saved}
        >
          {(p) => (
            <Input
              id={p.id}
              name="saved"
              inputMode="decimal"
              placeholder="0"
              aria-describedby={p.describedBy}
              aria-invalid={p.invalid || undefined}
            />
          )}
        </Field>
        <Field
          id="sim-deadline"
          label={t.deadline}
          optional={ro.netWorth.valuations.noteOptional}
          error={errors.fields.deadline}
        >
          {(p) => (
            <Input
              id={p.id}
              name="deadline"
              type="date"
              aria-describedby={p.describedBy}
              aria-invalid={p.invalid || undefined}
            />
          )}
        </Field>
        <Field
          id="sim-monthly"
          label={t.monthly}
          optional={ro.netWorth.valuations.noteOptional}
          error={errors.fields.monthly}
        >
          {(p) => (
            <Input
              id={p.id}
              name="monthly"
              inputMode="decimal"
              placeholder="500"
              aria-describedby={p.describedBy}
              aria-invalid={p.invalid || undefined}
            />
          )}
        </Field>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={!hydrated || pending} data-testid="savings-simulate">
            {pending ? t.simulating : t.simulate}
          </Button>
        </div>
      </form>
      {result ? (
        <div
          className="mt-4 rounded-md bg-surface-2 px-4 py-3 text-sm"
          role="status"
          data-testid="savings-result"
        >
          {result.byDeadline ? (
            <p>
              {result.byDeadline.status === "done"
                ? t.resultDone
                : result.byDeadline.status === "overdue"
                  ? t.resultOverdue
                  : t.resultDeadline(
                      formatMinor(result.byDeadline.dailyMinor ?? 0, result.currency),
                      formatMinor(result.byDeadline.weeklyMinor ?? 0, result.currency),
                      formatMinor(result.byDeadline.monthlyMinor ?? 0, result.currency),
                      result.byDeadline.daysLeft ?? 0,
                    )}
            </p>
          ) : null}
          {result.byMonthly && result.byMonthly.months !== null && result.byMonthly.finishOn ? (
            <p>{t.resultMonthly(result.byMonthly.months, formatDate(result.byMonthly.finishOn))}</p>
          ) : null}
          {result.byMonthly && result.byMonthly.months === 0 ? <p>{t.resultDone}</p> : null}
        </div>
      ) : null}
    </Card>
  );
}
