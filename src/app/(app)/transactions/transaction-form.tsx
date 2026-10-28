"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { ConfirmButton } from "@/components/ledger/confirm-button";
import { Field } from "@/components/ledger/field";
import { TagDot } from "@/components/planning/tag-chip";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { ro } from "@/messages/ro";
import type { TransactionJson } from "@/modules/transactions/transactions.schema";

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

export type AccountOption = Readonly<{ id: string; name: string; currency: string }>;
export type CategoryOption = Readonly<{ id: string; name: string; kind: string }>;
export type TagOption = Readonly<{ id: string; name: string; color: string | null }>;

/** Cel mult atâtea etichete pe o tranzacție (ca `MAX_TAGS_PER_TRANSACTION` din server). */
export const MAX_TAGS = 10;

type EntryType = "income" | "expense";

/**
 * Venitul sau cheltuiala: creare (`POST /api/v1/transactions`, cu `Idempotency-Key` per
 * trimitere) sau editare (`PATCH`) și ștergere (`DELETE`). Categoriile se filtrează după tip;
 * suma se parsează cu `parseAmount` și pleacă drept `amountMinor` (întreg). Etichetele (Faza 3):
 * bife, cel mult 10; la editare `tagIds` se trimite mereu și ÎNLOCUIEȘTE lista (pornind de la
 * etichetele curente, încărcate de pagină).
 */
export function TransactionForm({
  transaction,
  initialType,
  accounts,
  categories,
  tags = [],
  initialTagIds = [],
  today,
}: Readonly<{
  transaction?: TransactionJson;
  initialType: EntryType;
  accounts: readonly AccountOption[];
  categories: readonly CategoryOption[];
  tags?: readonly TagOption[];
  initialTagIds?: readonly string[];
  /** Data de azi (`Europe/Bucharest`), calculată pe server. */
  today: string;
}>) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [type, setType] = useState<EntryType>(initialType);
  const [accountId, setAccountId] = useState(transaction?.accountId ?? accounts[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState(transaction?.categoryId ?? "");
  const [tagIds, setTagIds] = useState<string[]>([...initialTagIds]);

  function toggleTag(id: string, checked: boolean) {
    setTagIds((current) =>
      checked
        ? current.includes(id)
          ? current
          : [...current, id]
        : current.filter((x) => x !== id),
    );
  }
  const currency = asCurrency(accounts.find((a) => a.id === accountId)?.currency ?? "RON");
  const visibleCategories = categories.filter((c) => c.kind === type);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const fields: Record<string, string> = {};
    const amount = parseAmountInput(String(form.get("amount") ?? ""), currency, { positive: true });
    if (!amount.ok) fields.amount = amount.message;
    if (!accountId) fields.accountId = ro.transactions.noAccounts;
    const occurredOn = String(form.get("occurredOn") ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) fields.occurredOn = ro.ledger.errors.invalid;
    if (tagIds.length > MAX_TAGS) fields.tagIds = ro.transactions.tooManyTags(MAX_TAGS);
    if (!amount.ok || Object.keys(fields).length > 0) {
      setErrors({ form: ro.ledger.errors.invalid, fields });
      return;
    }
    setErrors(NO_ERRORS);
    const text = (name: string) => String(form.get(name) ?? "").trim() || null;
    const body = {
      accountId,
      type,
      amountMinor: amount.amountMinor,
      occurredOn,
      categoryId: visibleCategories.some((c) => c.id === categoryId) ? categoryId : null,
      merchant: text("merchant"),
      description: text("description"),
      notes: text("notes"),
      tagIds,
    };
    const result = transaction
      ? await submit(`/api/v1/transactions/${transaction.id}`, "PATCH", body, {
          lockOnSuccess: true,
        })
      : await submit("/api/v1/transactions", "POST", body, {
          idempotent: true,
          lockOnSuccess: true,
        });
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      const mapped = apiErrors(result);
      const f: Record<string, string> = { ...mapped.fields };
      if (f.amountMinor) f.amount = f.amountMinor;
      setErrors({ form: mapped.form, fields: f });
      return;
    }
    router.push("/transactions");
    router.refresh();
  }

  async function remove() {
    if (!transaction) return;
    const result = await submit(`/api/v1/transactions/${transaction.id}`, "DELETE", undefined, {
      lockOnSuccess: true,
    });
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setErrors({ form: apiErrors(result).form, fields: {} });
      return;
    }
    router.push("/transactions");
    router.refresh();
  }

  const busy = pending || !hydrated;
  const t = ro.transactions;
  return (
    <Card>
      <form method="post" onSubmit={onSubmit} noValidate aria-busy={pending}>
        <CardContent>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t.type}</legend>
            <div className="flex flex-wrap gap-2">
              {(["expense", "income"] as const).map((value) => (
                <label
                  key={value}
                  className={
                    "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 " +
                    (type === value
                      ? "border-primary bg-accent-soft font-semibold"
                      : "border-border")
                  }
                >
                  <input
                    type="radio"
                    name="type"
                    value={value}
                    checked={type === value}
                    onChange={() => setType(value)}
                  />
                  {ro.ledger.types[value]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id="tx-account" label={t.account} error={errors.fields.accountId}>
              {(p) => (
                <Select
                  id={p.id}
                  name="accountId"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
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
            <Field id="tx-category" label={t.category} error={errors.fields.categoryId}>
              {(p) => (
                <Select
                  id={p.id}
                  name="categoryId"
                  value={visibleCategories.some((c) => c.id === categoryId) ? categoryId : ""}
                  onChange={(e) => setCategoryId(e.target.value)}
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                >
                  <option value="">{t.noCategory}</option>
                  {visibleCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              id="tx-amount"
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
                    transaction
                      ? amountInputValue(transaction.amountMinor, transaction.currency)
                      : ""
                  }
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                />
              )}
            </Field>
            <Field id="tx-date" label={t.date} error={errors.fields.occurredOn}>
              {(p) => (
                <Input
                  id={p.id}
                  name="occurredOn"
                  type="date"
                  required
                  defaultValue={transaction?.occurredOn ?? today}
                  aria-describedby={p.describedBy}
                  aria-invalid={p.invalid || undefined}
                />
              )}
            </Field>
            <Field
              id="tx-merchant"
              label={t.merchant}
              optional={ro.ledger.optional}
              error={errors.fields.merchant}
            >
              {(p) => (
                <Input
                  id={p.id}
                  name="merchant"
                  maxLength={200}
                  autoComplete="off"
                  defaultValue={transaction?.merchant ?? ""}
                  aria-describedby={p.describedBy}
                />
              )}
            </Field>
            <Field
              id="tx-description"
              label={t.description}
              optional={ro.ledger.optional}
              error={errors.fields.description}
            >
              {(p) => (
                <Input
                  id={p.id}
                  name="description"
                  maxLength={500}
                  autoComplete="off"
                  defaultValue={transaction?.description ?? ""}
                  aria-describedby={p.describedBy}
                />
              )}
            </Field>
          </div>
          <Field
            id="tx-notes"
            label={t.notes}
            optional={ro.ledger.optional}
            error={errors.fields.notes}
          >
            {(p) => (
              <textarea
                id={p.id}
                name="notes"
                maxLength={2000}
                rows={3}
                defaultValue={transaction?.notes ?? ""}
                aria-describedby={p.describedBy}
                className="w-full min-w-0 rounded-md border border-input bg-card px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              />
            )}
          </Field>
          <fieldset
            className="flex flex-col gap-2"
            aria-describedby={errors.fields.tagIds ? "tx-tags-hint tx-tags-error" : "tx-tags-hint"}
          >
            <legend className="mb-1 text-sm font-medium">
              {t.tags}
              <span className="ml-1 font-normal text-muted-foreground">({ro.ledger.optional})</span>
            </legend>
            {tags.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.noTagsYet}</p>
            ) : (
              <div className="flex flex-wrap gap-2" data-testid="tx-tags">
                {tags.map((tag) => {
                  const checked = tagIds.includes(tag.id);
                  return (
                    <label
                      key={tag.id}
                      className={
                        "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm " +
                        (checked ? "border-primary bg-accent-soft font-semibold" : "border-border")
                      }
                    >
                      <input
                        type="checkbox"
                        name="tagIds"
                        value={tag.id}
                        checked={checked}
                        disabled={!checked && tagIds.length >= MAX_TAGS}
                        onChange={(e) => toggleTag(tag.id, e.target.checked)}
                      />
                      <TagDot color={tag.color} />
                      {tag.name}
                    </label>
                  );
                })}
              </div>
            )}
            <p id="tx-tags-hint" className="text-xs text-muted-foreground">
              {t.tagsHint(MAX_TAGS)}
            </p>
            {errors.fields.tagIds ? (
              <p id="tx-tags-error" className="text-sm text-bad" data-testid="tx-tags-error">
                {errors.fields.tagIds}
              </p>
            ) : null}
          </fieldset>
          <Alert>{errors.form}</Alert>
          <div className="flex flex-wrap items-start gap-2">
            <Button type="submit" disabled={busy}>
              {pending ? ro.ledger.saving : ro.ledger.save}
            </Button>
            <Button variant="ghost" onClick={() => router.push("/transactions")} disabled={pending}>
              {ro.ledger.cancel}
            </Button>
            {transaction ? (
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
