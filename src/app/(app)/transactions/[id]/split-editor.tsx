"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { ConfirmButton } from "@/components/ledger/confirm-button";
import { Field } from "@/components/ledger/field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { Currency } from "@/lib/money";
import { ro } from "@/messages/ro";

import { goToLogin } from "../../../_lib/api-client";
import { parsePercentInput } from "../../../_lib/family-ui";
import {
  type FormErrors,
  NO_ERRORS,
  amountInputValue,
  apiErrors,
  formatMinor,
  parseAmountInput,
} from "../../../_lib/ledger-ui";
import { useHydrated } from "../../../_lib/use-hydrated";
import { useSubmit } from "../../../_lib/use-submit";

export type SplitJson = Readonly<{
  transactionId: string;
  payerUserId: string;
  currency: Currency;
  totalMinor: number;
  shares: readonly Readonly<{ userId: string; shareMinor: number }>[];
}>;

type Member = Readonly<{ userId: string; name: string }>;
type Mode = "equal" | "percent" | "fixed";

/**
 * Împărțirea unei cheltuieli (Faza 8, ADR 0016, punctul 7): doar plătitorul (contul lui personal)
 * o setează: în părți egale, pe procente (puncte de bază exacte: „33,33” → 3333) sau sume fixe.
 * Calculul și rotunjirea le face serverul (`split-math.ts`); aici doar se validează forma. Cât timp
 * există, suma/contul/tipul tranzacției nu se schimbă (409 `transaction_split`, explicat mai jos).
 */
export function SplitEditor({
  transactionId,
  totalMinor,
  currency,
  members,
  meUserId,
  split,
  canEdit,
  reason,
}: Readonly<{
  transactionId: string;
  totalMinor: number;
  currency: Currency;
  members: readonly Member[];
  meUserId: string;
  split: SplitJson | null;
  canEdit: boolean;
  /** De ce nu se poate împărți (text), dacă `canEdit` e fals. */
  reason: string | null;
}>) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [info, setInfo] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("equal");
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(split ? split.shares.map((s) => s.userId) : members.map((m) => m.userId)),
  );
  const t = ro.split;
  const nameOf = (id: string) =>
    `${members.find((m) => m.userId === id)?.name ?? ro.family.formerMember}${id === meUserId ? ` (${ro.family.you})` : ""}`;
  const busy = pending || !hydrated;
  const chosen = members.filter((m) => selected.has(m.userId));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setInfo(null);
    if (chosen.length < 2) {
      setErrors({ form: t.needTwo, fields: {} });
      return;
    }
    const fields: Record<string, string> = {};
    let body: unknown;
    if (mode === "equal") {
      body = { mode, userIds: chosen.map((m) => m.userId) };
    } else if (mode === "percent") {
      const shares = chosen.map((m) => {
        const parsed = parsePercentInput(String(form.get(`pct-${m.userId}`) ?? ""));
        if (!parsed.ok) fields[`pct-${m.userId}`] = parsed.message;
        return { userId: m.userId, basisPoints: parsed.ok ? parsed.basisPoints : 0 };
      });
      body = { mode, shares };
    } else {
      const shares = chosen.map((m) => {
        const text = String(form.get(`amt-${m.userId}`) ?? "").trim();
        const parsed = text === "" ? null : parseAmountInput(text, currency);
        if (parsed && !parsed.ok) fields[`amt-${m.userId}`] = parsed.message;
        return { userId: m.userId, amountMinor: parsed && parsed.ok ? parsed.amountMinor : 0 };
      });
      body = { mode, shares };
    }
    if (Object.keys(fields).length > 0) {
      setErrors({ form: ro.ledger.errors.invalid, fields });
      return;
    }
    setErrors(NO_ERRORS);
    const result = await submit(`/api/v1/transactions/${transactionId}/split`, "PUT", body);
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setErrors(apiErrors(result));
      return;
    }
    setInfo(t.saved);
    router.refresh();
  }

  async function clear() {
    setInfo(null);
    const result = await submit(`/api/v1/transactions/${transactionId}/split`, "DELETE");
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setErrors(apiErrors(result));
      return;
    }
    setInfo(t.cleared);
    router.refresh();
  }

  const current = split ? (
    <div className="flex flex-col gap-1" data-testid="split-current">
      <p className="text-sm font-semibold">{t.current}</p>
      <ul className="text-sm">
        {split.shares.map((s) => (
          <li key={s.userId} className="flex justify-between gap-2">
            <span>{nameOf(s.userId)}</span>
            <span className="font-mono tabular-nums">
              {formatMinor(s.shareMinor, split.currency)}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">{t.locked}</p>
    </div>
  ) : null;

  return (
    <Card data-testid="split-editor">
      <CardHeader>
        <CardTitle>{t.title}</CardTitle>
        <CardDescription>{t.hint}</CardDescription>
      </CardHeader>
      <CardContent>
        {current}
        {!canEdit ? (
          reason ? (
            <p className="text-muted-foreground">{reason}</p>
          ) : null
        ) : (
          <form onSubmit={onSubmit} noValidate aria-busy={pending} className="flex flex-col gap-3">
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm font-medium">{t.mode}</legend>
              {(["equal", "percent", "fixed"] as const).map((m) => (
                <label key={m} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="mode"
                    value={m}
                    checked={mode === m}
                    onChange={() => setMode(m)}
                    className="size-4"
                    data-testid={`split-mode-${m}`}
                  />
                  {t.modes[m]}
                </label>
              ))}
            </fieldset>
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm font-medium">{t.participants}</legend>
              {members.map((m) => (
                <label key={m.userId} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(m.userId)}
                    onChange={() => toggle(m.userId)}
                    className="size-4"
                    data-testid="split-participant"
                    data-member-name={m.name}
                  />
                  {nameOf(m.userId)}
                </label>
              ))}
            </fieldset>
            {mode === "percent" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {chosen.map((m) => {
                  return (
                    <Field
                      key={m.userId}
                      id={`pct-${m.userId}`}
                      label={t.percentOf(nameOf(m.userId))}
                      hint={t.percentHint}
                      error={errors.fields[`pct-${m.userId}`]}
                    >
                      {(p) => (
                        <Input
                          id={p.id}
                          name={p.id}
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="50"
                          aria-describedby={p.describedBy}
                          aria-invalid={p.invalid || undefined}
                        />
                      )}
                    </Field>
                  );
                })}
              </div>
            ) : null}
            {mode === "fixed" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {chosen.map((m) => {
                  const prev = split?.shares.find((s) => s.userId === m.userId);
                  return (
                    <Field
                      key={m.userId}
                      id={`amt-${m.userId}`}
                      label={t.amountOf(nameOf(m.userId))}
                      hint={t.fixedHint(formatMinor(totalMinor, currency))}
                      error={errors.fields[`amt-${m.userId}`]}
                    >
                      {(p) => (
                        <Input
                          id={p.id}
                          name={p.id}
                          inputMode="decimal"
                          autoComplete="off"
                          defaultValue={prev ? amountInputValue(prev.shareMinor, currency) : ""}
                          aria-describedby={p.describedBy}
                          aria-invalid={p.invalid || undefined}
                        />
                      )}
                    </Field>
                  );
                })}
              </div>
            ) : null}
            <Alert>{errors.form}</Alert>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy} data-testid="split-save">
                {pending ? t.saving : t.save}
              </Button>
              {split ? (
                <ConfirmButton
                  label={t.clear}
                  question={t.clearConfirm}
                  confirmLabel={t.clearYes}
                  busy={busy}
                  onConfirm={() => void clear()}
                />
              ) : null}
            </div>
          </form>
        )}
        <Alert tone="ok" data-testid="split-result">
          {info}
        </Alert>
      </CardContent>
    </Card>
  );
}
