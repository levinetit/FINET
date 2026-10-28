"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { ConfirmButton } from "@/components/ledger/confirm-button";
import { Field } from "@/components/ledger/field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ro } from "@/messages/ro";
import type { CategoryJson } from "@/modules/categories/categories.schema";

import { goToLogin } from "../../_lib/api-client";
import { type FormErrors, NO_ERRORS, apiErrors } from "../../_lib/ledger-ui";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

/**
 * Categoriile (5.4, 5.6): cele de sistem se pot doar ascunde/afișa (per gospodărie); cele
 * personalizate (un singur nivel) se creează, se redenumesc, se ascund și se șterg cu reasignarea
 * tranzacțiilor într-o categorie de același tip (`DELETE /categories/{id}?reassignToId=`).
 */
export function CategoriesManager({
  categories,
  kinds,
}: Readonly<{ categories: readonly CategoryJson[]; kinds: readonly string[] }>) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [reassign, setReassign] = useState<Record<string, string>>({});
  const busy = pending || !hydrated;

  function failed(result: { status: number; error: Parameters<typeof apiErrors>[0]["error"] }) {
    if (result.status === 401) {
      goToLogin();
      return true;
    }
    return false;
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const name = String(form.get("name") ?? "").trim();
    setInfo(null);
    if (name.length < 1 || name.length > 60) {
      setErrors({ form: ro.ledger.errors.invalid, fields: { name: ro.categories.invalidName } });
      return;
    }
    setErrors(NO_ERRORS);
    const result = await submit(
      "/api/v1/categories",
      "POST",
      { name, kind: String(form.get("kind")) },
      { idempotent: true },
    );
    if (!result || failed(result)) return;
    if (!result.ok) {
      setErrors(apiErrors(result));
      return;
    }
    formEl.reset();
    setInfo(ro.categories.created);
    router.refresh();
  }

  async function rowAction(id: string, run: () => ReturnType<typeof submit>, ok: string) {
    setRowError(null);
    setInfo(null);
    const result = await run();
    if (!result || failed(result)) return;
    if (!result.ok) {
      const mapped = apiErrors(result);
      setRowError({ id, message: Object.values(mapped.fields)[0] ?? mapped.form ?? "" });
      return;
    }
    setInfo(ok);
    setRenaming(null);
    router.refresh();
  }

  function setHidden(c: CategoryJson, hidden: boolean) {
    return rowAction(
      c.id,
      () => submit(`/api/v1/categories/${c.id}/${hidden ? "hide" : "unhide"}`, "POST"),
      ro.ledger.saved,
    );
  }

  function rename(event: FormEvent<HTMLFormElement>, c: CategoryJson) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (name.length < 1 || name.length > 60) {
      setRowError({ id: c.id, message: ro.categories.invalidName });
      return;
    }
    return rowAction(
      c.id,
      () => submit(`/api/v1/categories/${c.id}`, "PATCH", { name }),
      ro.ledger.saved,
    );
  }

  async function remove(c: CategoryJson) {
    const target = reassign[c.id] ?? "";
    const query = target ? `?reassignToId=${encodeURIComponent(target)}` : "";
    setRowError(null);
    setInfo(null);
    const result = await submit<{ reassigned: number }>(
      `/api/v1/categories/${c.id}${query}`,
      "DELETE",
    );
    if (!result || failed(result)) return;
    if (!result.ok) {
      const mapped = apiErrors(result);
      setRowError({ id: c.id, message: Object.values(mapped.fields)[0] ?? mapped.form ?? "" });
      return;
    }
    setInfo(ro.categories.deleted(result.data?.reassigned ?? 0));
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <Card aria-labelledby="new-category-title">
        <CardHeader>
          <CardTitle id="new-category-title">{ro.categories.newTitle}</CardTitle>
        </CardHeader>
        <form method="post" onSubmit={create} noValidate aria-busy={pending}>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <Field id="category-name" label={ro.categories.name} error={errors.fields.name}>
                {(p) => (
                  <Input
                    id={p.id}
                    name="name"
                    maxLength={60}
                    autoComplete="off"
                    aria-describedby={p.describedBy}
                    aria-invalid={p.invalid || undefined}
                  />
                )}
              </Field>
              <Field id="category-kind" label={ro.categories.kind} error={errors.fields.kind}>
                {(p) => (
                  <Select
                    id={p.id}
                    name="kind"
                    defaultValue="expense"
                    aria-describedby={p.describedBy}
                  >
                    {kinds.map((k) => (
                      <option key={k} value={k}>
                        {ro.ledger.types[k] ?? k}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <Alert>{errors.form}</Alert>
            <div>
              <Button type="submit" disabled={busy}>
                {pending ? ro.ledger.saving : ro.categories.add}
              </Button>
            </div>
          </CardContent>
        </form>
      </Card>
      <Alert tone="ok">{info}</Alert>
      {kinds.map((kind) => {
        const list = categories.filter((c) => c.kind === kind);
        return (
          <Card key={kind} aria-labelledby={`kind-${kind}`}>
            <CardHeader>
              <CardTitle id={`kind-${kind}`}>{ro.ledger.kinds[kind] ?? kind}</CardTitle>
            </CardHeader>
            {list.length === 0 ? (
              <p className="text-muted-foreground">{ro.categories.empty}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {list.map((c) => {
                  const targets = categories.filter(
                    (t) => t.kind === c.kind && t.id !== c.id && !t.hidden,
                  );
                  return (
                    <li
                      key={c.id}
                      className="flex flex-col gap-2 py-3"
                      data-testid="category-row"
                      data-category-name={c.name}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex min-w-0 flex-wrap items-center gap-2">
                          <span
                            className={
                              c.hidden ? "font-semibold text-muted-foreground" : "font-semibold"
                            }
                          >
                            {c.name}
                          </span>
                          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">
                            {c.isSystem ? ro.categories.system : ro.categories.custom}
                          </span>
                          {c.hidden ? (
                            <span
                              className="rounded bg-warn-soft px-1.5 py-0.5 text-xs"
                              data-testid="hidden-badge"
                            >
                              {ro.categories.hidden}
                            </span>
                          ) : null}
                        </span>
                        <span className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => void setHidden(c, !c.hidden)}
                            aria-label={`${c.hidden ? ro.categories.show : ro.categories.hide}: ${c.name}`}
                          >
                            {c.hidden ? ro.categories.show : ro.categories.hide}
                          </Button>
                          {c.isSystem ? null : (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => setRenaming(renaming === c.id ? null : c.id)}
                              aria-label={`${ro.categories.rename}: ${c.name}`}
                            >
                              {ro.categories.rename}
                            </Button>
                          )}
                        </span>
                      </div>
                      {renaming === c.id ? (
                        <form
                          className="flex flex-wrap items-end gap-2"
                          onSubmit={(e) => void rename(e, c)}
                          noValidate
                        >
                          <div className="flex min-w-0 grow flex-col gap-1.5">
                            <Label htmlFor={`rename-${c.id}`}>{ro.categories.name}</Label>
                            <Input
                              id={`rename-${c.id}`}
                              name="name"
                              defaultValue={c.name}
                              maxLength={60}
                            />
                          </div>
                          <Button type="submit" size="sm" disabled={busy}>
                            {ro.ledger.save}
                          </Button>
                        </form>
                      ) : null}
                      {c.isSystem ? null : (
                        <ConfirmButton
                          label={`${ro.ledger.delete}`}
                          question={ro.categories.deleteConfirm}
                          busy={busy}
                          onConfirm={() => void remove(c)}
                        >
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor={`reassign-${c.id}`}>
                              {ro.categories.reassignLabel}
                            </Label>
                            <Select
                              id={`reassign-${c.id}`}
                              value={reassign[c.id] ?? ""}
                              onChange={(e) => setReassign({ ...reassign, [c.id]: e.target.value })}
                            >
                              <option value="">{ro.categories.reassignNone}</option>
                              {targets.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.name}
                                </option>
                              ))}
                            </Select>
                          </div>
                        </ConfirmButton>
                      )}
                      {rowError?.id === c.id ? <Alert>{rowError.message}</Alert> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        );
      })}
    </div>
  );
}
