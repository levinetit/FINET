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
import type { BudgetJson } from "@/modules/budgets/budgets.schema";

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

export type ExpenseCategoryOption = Readonly<{ id: string; name: string }>;

const DEFAULT_WARN = "80";

/** Pragul de avertizare: întreg 1–100 (text din câmp). */
function parseWarn(text: string): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const n = Number.parseInt(text.trim(), 10);
  return n >= 1 && n <= 100 ? n : null;
}

/**
 * Bugetul: creare (`POST /api/v1/budgets`: categoria de cheltuieli sau general, limita, moneda,
 * pragul, domeniul `household|personal`) sau editare (`PATCH`: DOAR limita, pragul și arhivarea;
 * categoria, moneda și domeniul nu se schimbă — schema strictă le refuză) și ștergere cu
 * confirmare. Suma prin `parseAmount` → `amountMinor` întreg.
 */
export function BudgetForm({
  budget,
  categories,
  currencies,
  scopes,
  defaultCurrency,
}: Readonly<{
  budget?: BudgetJson;
  categories: readonly ExpenseCategoryOption[];
  currencies: readonly string[];
  scopes: readonly string[];
  defaultCurrency: string;
}>) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [currency, setCurrency] = useState(budget?.currency ?? defaultCurrency);
  const t = ro.budgets;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const fields: Record<string, string> = {};
    const amount = parseAmountInput(String(form.get("amount") ?? ""), asCurrency(currency), {
      positive: true,
    });
    if (!amount.ok) fields.amount = amount.message;
    const warn = parseWarn(String(form.get("warnPct") ?? ""));
    if (warn === null) fields.warnPct = t.invalidWarnPct;
    if (!amount.ok || warn === null) {
      setErrors({ form: ro.ledger.errors.invalid, fields });
      return;
    }
    setErrors(NO_ERRORS);
    const categoryId = String(form.get("categoryId") ?? "");
    const result = budget
      ? await submit(
          `/api/v1/budgets/${budget.id}`,
          "PATCH",
          { amountMinor: amount.amountMinor, warnPct: warn },
          { lockOnSuccess: true },
        )
      : await submit(
          "/api/v1/budgets",
          "POST",
          {
            categoryId: categoryId || null,
            amountMinor: amount.amountMinor,
            currency,
            warnPct: warn,
            scope: String(form.get("scope") ?? "household"),
          },
          { idempotent: true, lockOnSuccess: true },
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
    router.push("/budgets");
    router.refresh();
  }

  async function action(method: "PATCH" | "DELETE", body?: unknown) {
    if (!budget) return;
    const result = await submit(`/api/v1/budgets/${budget.id}`, method, body, {
      lockOnSuccess: true,
    });
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setErrors({ form: apiErrors(result).form, fields: {} });
      return;
    }
    router.push("/budgets");
    router.refresh();
  }

  const busy = pending || !hydrated;
  return (
    <Card>
      <form method="post" onSubmit={onSubmit} noValidate aria-busy={pending}>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              id="budget-category"
              label={t.category}
              hint={budget ? t.lockedHint : t.categoryHint}
              error={errors.fields.categoryId}
            >
              {(p) => (
                <Select
                  id={p.id}
                  name="categoryId"
                  defaultValue={budget?.categoryId ?? ""}
                  disabled={Boolean(budget)}
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                >
                  <option value="">{t.general}</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field id="budget-scope" label={t.scope} error={errors.fields.scope}>
              {(p) => (
                <Select
                  id={p.id}
                  name="scope"
                  defaultValue={budget?.scope ?? "household"}
                  disabled={Boolean(budget)}
                  aria-describedby={p.describedBy}
                >
                  {scopes.map((s) => (
                    <option key={s} value={s}>
                      {t.scopes[s] ?? s}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field id="budget-currency" label={t.currency} error={errors.fields.currency}>
              {(p) => (
                <Select
                  id={p.id}
                  name="currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  disabled={Boolean(budget)}
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
              id="budget-amount"
              label={`${t.amount} (${currency})`}
              hint={ro.ledger.amountHint}
              error={errors.fields.amount}
            >
              {(p) => (
                <Input
                  id={p.id}
                  name="amount"
                  inputMode="decimal"
                  autoComplete="off"
                  required
                  defaultValue={
                    budget ? amountInputValue(budget.amountMinor, asCurrency(budget.currency)) : ""
                  }
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                />
              )}
            </Field>
            <Field
              id="budget-warn"
              label={t.warnPct}
              hint={t.warnPctHint}
              error={errors.fields.warnPct}
            >
              {(p) => (
                <Input
                  id={p.id}
                  name="warnPct"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={3}
                  defaultValue={budget ? String(budget.warnPct) : DEFAULT_WARN}
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
            <Button variant="ghost" onClick={() => router.push("/budgets")} disabled={pending}>
              {ro.ledger.cancel}
            </Button>
            {budget ? (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void action("PATCH", { archived: budget.archivedAt === null })}
                >
                  {budget.archivedAt === null ? t.archive : t.unarchive}
                </Button>
                <ConfirmButton
                  label={ro.ledger.delete}
                  question={t.deleteConfirm}
                  busy={busy}
                  onConfirm={() => void action("DELETE")}
                />
              </>
            ) : null}
          </div>
        </CardContent>
      </form>
    </Card>
  );
}
