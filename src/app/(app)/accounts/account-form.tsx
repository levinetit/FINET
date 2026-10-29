"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { Field } from "@/components/ledger/field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { ro } from "@/messages/ro";
import type { AccountJson } from "@/modules/accounts/accounts.schema";

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

/**
 * Crearea (`POST /api/v1/accounts`, cu `Idempotency-Key`) și editarea
 * (`PATCH /api/v1/accounts/{id}`) unui cont. Soldul inițial se parsează cu `parseAmount`
 * (virgulă sau punct; valorile ambigue sunt respinse) și pleacă drept `openingBalanceMinor`.
 */
export function AccountForm({
  account,
  types,
  currencies,
  currencyLocked = false,
  meUserId,
}: Readonly<{
  account?: AccountJson;
  types: readonly string[];
  currencies: readonly string[];
  /** Contul are tranzacții: moneda nu se mai schimbă. */
  currencyLocked?: boolean;
  /** Utilizatorul curent (Faza 8): un cont personal se creează doar pentru tine. */
  meUserId?: string;
}>) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const currency = asCurrency(String(form.get("currency") ?? account?.currency ?? "RON"));
    const balanceText = String(form.get("openingBalance") ?? "").trim();
    const fields: Record<string, string> = {};
    if (name.length < 1 || name.length > 100) fields.name = ro.accounts.invalidName;
    let openingBalanceMinor = 0;
    if (balanceText !== "") {
      const parsed = parseAmountInput(balanceText, currency, { allowNegative: true });
      if (parsed.ok) openingBalanceMinor = parsed.amountMinor;
      else fields.openingBalance = parsed.message;
    }
    if (Object.keys(fields).length > 0) {
      setErrors({ form: ro.ledger.errors.invalid, fields });
      return;
    }
    setErrors(NO_ERRORS);
    const body: Record<string, unknown> = {
      name,
      type: String(form.get("type")),
      openingBalanceMinor,
    };
    if (!account || !currencyLocked) body.currency = currency;
    // Faza 8 (ADR 0016): personal = doar al tău; un cont comun nu devine personal.
    const personal = form.get("personal") === "on";
    if (!account && personal && meUserId) body.ownerUserId = meUserId;
    if (account && account.ownerUserId !== null && !personal) body.ownerUserId = null;
    const result = account
      ? await submit<AccountJson>(`/api/v1/accounts/${account.id}`, "PATCH", body, {
          lockOnSuccess: true,
        })
      : await submit<AccountJson>("/api/v1/accounts", "POST", body, {
          idempotent: true,
          lockOnSuccess: true,
        });
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      const mapped = apiErrors(result);
      // `openingBalanceMinor` e câmpul API al sumei scrise în `openingBalance`.
      const f: Record<string, string> = { ...mapped.fields };
      if (f.openingBalanceMinor) f.openingBalance = f.openingBalanceMinor;
      setErrors({ form: mapped.form, fields: f });
      return;
    }
    router.push("/accounts");
    router.refresh();
  }

  const busy = pending || !hydrated;
  return (
    <Card>
      <form method="post" onSubmit={onSubmit} noValidate aria-busy={pending}>
        <CardContent>
          <Field id="account-name" label={ro.accounts.name} error={errors.fields.name}>
            {(p) => (
              <Input
                id={p.id}
                name="name"
                defaultValue={account?.name}
                maxLength={100}
                required
                autoComplete="off"
                aria-describedby={p.describedBy}
                aria-invalid={p.invalid || undefined}
              />
            )}
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id="account-type" label={ro.accounts.type} error={errors.fields.type}>
              {(p) => (
                <Select
                  id={p.id}
                  name="type"
                  defaultValue={account?.type ?? "bank"}
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                >
                  {types.map((t) => (
                    <option key={t} value={t}>
                      {ro.ledger.accountTypes[t] ?? t}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              id="account-currency"
              label={ro.accounts.currency}
              hint={account && currencyLocked ? ro.accounts.currencyLocked : undefined}
              error={errors.fields.currency}
            >
              {(p) => (
                <Select
                  id={p.id}
                  name="currency"
                  defaultValue={account?.currency ?? "RON"}
                  disabled={Boolean(account && currencyLocked)}
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                >
                  {currencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Field
            id="account-opening"
            label={ro.accounts.openingBalance}
            hint={`${ro.accounts.openingBalanceHint} ${ro.ledger.amountHint}`}
            error={errors.fields.openingBalance}
          >
            {(p) => (
              <Input
                id={p.id}
                name="openingBalance"
                inputMode="decimal"
                autoComplete="off"
                defaultValue={
                  account ? amountInputValue(account.openingBalanceMinor, account.currency) : ""
                }
                aria-describedby={p.describedBy}
                aria-invalid={p.invalid || undefined}
              />
            )}
          </Field>
          {meUserId && (!account || account.ownerUserId === meUserId) ? (
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  name="personal"
                  defaultChecked={Boolean(account && account.ownerUserId === meUserId)}
                  className="size-4"
                  aria-describedby="account-personal-hint"
                  data-testid="account-personal"
                />
                {ro.accounts.personal}
              </label>
              <p id="account-personal-hint" className="text-xs text-muted-foreground">
                {account ? ro.accounts.personalEditHint : ro.accounts.personalHint}
              </p>
            </div>
          ) : account ? (
            <p className="text-xs text-muted-foreground">{ro.accounts.commonHint}</p>
          ) : null}
          <Alert>{errors.form}</Alert>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {pending ? ro.ledger.saving : ro.ledger.save}
            </Button>
            <Button variant="ghost" onClick={() => router.push("/accounts")} disabled={pending}>
              {ro.ledger.cancel}
            </Button>
          </div>
        </CardContent>
      </form>
    </Card>
  );
}
