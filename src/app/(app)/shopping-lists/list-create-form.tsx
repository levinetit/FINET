"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { Field } from "@/components/ledger/field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ro } from "@/messages/ro";
import type { ListWithItemsJson } from "@/modules/shopping/shopping.schema";

import { goToLogin } from "../../_lib/api-client";
import { apiErrors } from "../../_lib/ledger-ui";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

const NAME_MAX = 100;

/** Lista nouă (`POST /api/v1/shopping-lists`, cu `Idempotency-Key`), apoi deschide lista. */
export function ListCreateForm() {
  const t = ro.shopping;
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    if (name.length < 1 || name.length > NAME_MAX) {
      setNameError(t.invalidName);
      return;
    }
    setNameError(null);
    setError(null);
    const result = await submit<ListWithItemsJson>(
      "/api/v1/shopping-lists",
      "POST",
      { name, personal: form.get("personal") === "on" },
      { idempotent: true, lockOnSuccess: true },
    );
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok || !result.data) {
      setError(apiErrors(result).form);
      return;
    }
    router.push(`/shopping-lists/${result.data.list.id}`);
    router.refresh();
  }

  return (
    <Card aria-labelledby="new-list-title">
      <CardHeader>
        <CardTitle id="new-list-title">{t.newTitle}</CardTitle>
      </CardHeader>
      <form method="post" onSubmit={onSubmit} noValidate aria-busy={pending}>
        <CardContent>
          <Field id="new-list-name" label={t.name} error={nameError}>
            {(p) => (
              <Input
                id={p.id}
                name="name"
                maxLength={NAME_MAX}
                autoComplete="off"
                placeholder={t.namePlaceholder}
                required
                aria-describedby={p.describedBy}
                aria-invalid={p.invalid || undefined}
                data-testid="new-list-name"
              />
            )}
          </Field>
          <label className="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              name="personal"
              className="size-5 accent-primary"
              data-testid="new-list-personal"
            />
            <span>
              {t.personal}
              <span className="block text-xs text-muted-foreground">{t.personalHint}</span>
            </span>
          </label>
          <Alert>{error}</Alert>
          <div>
            <Button type="submit" disabled={pending || !hydrated} data-testid="new-list-submit">
              {pending ? t.creating : t.create}
            </Button>
          </div>
        </CardContent>
      </form>
    </Card>
  );
}
