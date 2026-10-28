"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { ConfirmButton } from "@/components/ledger/confirm-button";
import { Field } from "@/components/ledger/field";
import { TagDot } from "@/components/planning/tag-chip";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ro } from "@/messages/ro";
import type { TagJson } from "@/modules/tags/tags.schema";

import { goToLogin } from "../../_lib/api-client";
import { type FormErrors, NO_ERRORS, apiErrors } from "../../_lib/ledger-ui";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

const NAME_MAX = 40;
const DEFAULT_COLOR = "#1f45b8";

/** Culoarea din formular: `null` dacă „Fără culoare” e bifat, altfel `#rrggbb`. */
function colorOf(form: FormData): string | null {
  if (form.get("noColor") === "on") return null;
  const value = String(form.get("color") ?? "").toLowerCase();
  return /^#[0-9a-f]{6}$/.test(value) ? value : null;
}

/**
 * Etichetele (5.4): cele de sistem se pot doar ascunde/afișa; cele ale gospodăriei se creează,
 * se redenumesc, își schimbă culoarea, se ascund și se șterg cu confirmare (legăturile cu
 * tranzacțiile dispar, tranzacțiile rămân). Mutațiile prin `/api/v1/tags`.
 */
export function TagsManager({ tags }: Readonly<{ tags: readonly TagJson[] }>) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const busy = pending || !hydrated;
  const t = ro.tags;

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const name = String(form.get("name") ?? "").trim();
    setInfo(null);
    if (name.length < 1 || name.length > NAME_MAX) {
      setErrors({ form: ro.ledger.errors.invalid, fields: { name: t.invalidName } });
      return;
    }
    setErrors(NO_ERRORS);
    const result = await submit(
      "/api/v1/tags",
      "POST",
      { name, color: colorOf(form) },
      { idempotent: true },
    );
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setErrors(apiErrors(result));
      return;
    }
    formEl.reset();
    setInfo(t.created);
    router.refresh();
  }

  async function rowAction(id: string, run: () => ReturnType<typeof submit>, ok: string) {
    setRowError(null);
    setInfo(null);
    const result = await run();
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      const mapped = apiErrors(result);
      setRowError({ id, message: Object.values(mapped.fields)[0] ?? mapped.form ?? "" });
      return;
    }
    setInfo(ok);
    setEditing(null);
    router.refresh();
  }

  function edit(event: FormEvent<HTMLFormElement>, tag: TagJson) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    if (name.length < 1 || name.length > NAME_MAX) {
      setRowError({ id: tag.id, message: t.invalidName });
      return;
    }
    return rowAction(
      tag.id,
      () => submit(`/api/v1/tags/${tag.id}`, "PATCH", { name, color: colorOf(form) }),
      ro.ledger.saved,
    );
  }

  const system = tags.filter((x) => x.isSystem);
  const custom = tags.filter((x) => !x.isSystem);

  function row(tag: TagJson) {
    return (
      <li
        key={tag.id}
        className="flex flex-col gap-2 py-3"
        data-testid="tag-row"
        data-tag-name={tag.name}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <TagDot color={tag.color} />
            <span className={tag.hidden ? "font-semibold text-muted-foreground" : "font-semibold"}>
              {tag.name}
            </span>
            <span className="text-sm text-muted-foreground">{t.usage(tag.usageCount)}</span>
            {tag.hidden ? (
              <span
                className="rounded bg-warn-soft px-1.5 py-0.5 text-xs"
                data-testid="hidden-badge"
              >
                {t.hidden}
              </span>
            ) : null}
          </span>
          <span className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              aria-label={`${tag.hidden ? t.show : t.hide}: ${tag.name}`}
              onClick={() =>
                void rowAction(
                  tag.id,
                  () => submit(`/api/v1/tags/${tag.id}`, "PATCH", { hidden: !tag.hidden }),
                  ro.ledger.saved,
                )
              }
            >
              {tag.hidden ? t.show : t.hide}
            </Button>
            {tag.isSystem ? null : (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                aria-expanded={editing === tag.id}
                aria-label={`${t.edit}: ${tag.name}`}
                onClick={() => setEditing(editing === tag.id ? null : tag.id)}
              >
                {t.edit}
              </Button>
            )}
          </span>
        </div>
        {editing === tag.id ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => void edit(e, tag)}
            noValidate
          >
            <div className="flex min-w-0 grow flex-col gap-1.5">
              <Label htmlFor={`tag-name-${tag.id}`}>{t.name}</Label>
              <Input
                id={`tag-name-${tag.id}`}
                name="name"
                defaultValue={tag.name}
                maxLength={NAME_MAX}
                autoComplete="off"
              />
            </div>
            <ColorFields idPrefix={`tag-${tag.id}`} color={tag.color} />
            <Button type="submit" size="sm" disabled={busy}>
              {ro.ledger.save}
            </Button>
          </form>
        ) : null}
        {tag.isSystem ? null : (
          <ConfirmButton
            label={ro.ledger.delete}
            question={t.deleteConfirm(tag.usageCount)}
            busy={busy}
            onConfirm={() =>
              void rowAction(tag.id, () => submit(`/api/v1/tags/${tag.id}`, "DELETE"), t.deleted)
            }
          />
        )}
        {rowError?.id === tag.id ? <Alert>{rowError.message}</Alert> : null}
      </li>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card aria-labelledby="new-tag-title">
        <CardHeader>
          <CardTitle id="new-tag-title">{t.newTitle}</CardTitle>
          <CardDescription>{t.intro}</CardDescription>
        </CardHeader>
        <form method="post" onSubmit={create} noValidate aria-busy={pending}>
          <CardContent>
            <div className="flex flex-wrap items-end gap-4">
              <Field id="tag-name" label={t.name} error={errors.fields.name} className="grow">
                {(p) => (
                  <Input
                    id={p.id}
                    name="name"
                    maxLength={NAME_MAX}
                    autoComplete="off"
                    aria-describedby={p.describedBy}
                    aria-invalid={p.invalid || undefined}
                  />
                )}
              </Field>
              <ColorFields idPrefix="tag-new" color={null} />
            </div>
            <Alert>{errors.form}</Alert>
            <div>
              <Button type="submit" disabled={busy}>
                {pending ? ro.ledger.saving : t.add}
              </Button>
            </div>
          </CardContent>
        </form>
      </Card>
      <Alert tone="ok">{info}</Alert>
      <Card aria-labelledby="custom-tags">
        <CardHeader>
          <CardTitle id="custom-tags">{t.customList}</CardTitle>
        </CardHeader>
        {custom.length === 0 ? (
          <p className="text-muted-foreground">{t.empty}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">{custom.map(row)}</ul>
        )}
      </Card>
      <Card aria-labelledby="system-tags">
        <CardHeader>
          <CardTitle id="system-tags">{t.systemList}</CardTitle>
        </CardHeader>
        <ul className="flex flex-col divide-y divide-border">{system.map(row)}</ul>
      </Card>
    </div>
  );
}

/** Culoarea (`<input type="color">`) și „Fără culoare”. */
function ColorFields({ idPrefix, color }: Readonly<{ idPrefix: string; color: string | null }>) {
  return (
    <div className="flex items-end gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-color`}>{ro.tags.color}</Label>
        <input
          id={`${idPrefix}-color`}
          name="color"
          type="color"
          defaultValue={color ?? DEFAULT_COLOR}
          className="h-11 w-14 cursor-pointer rounded-md border border-input bg-card p-1 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        />
      </div>
      <label className="flex h-11 items-center gap-2 text-sm">
        <input type="checkbox" name="noColor" defaultChecked={color === null} />
        {ro.tags.noColor}
      </label>
    </div>
  );
}
