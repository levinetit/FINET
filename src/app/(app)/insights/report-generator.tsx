"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { Field } from "@/components/ledger/field";
import { ReportResult } from "@/components/insights/report-result";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { REPORT_PERIODS, type ReportPeriod } from "@/lib/periods";
import { ro } from "@/messages/ro";
import type {
  DefinitionJson,
  RunJson,
} from "@/modules/report-definitions/report-definitions.schema";
import {
  DEFAULT_KINDS,
  LINE_KINDS,
  MAX_FILTER_IDS,
  MAX_TERMS,
  RULE_TYPES,
  type LineKindFilter,
  type RuleType,
} from "@/modules/report-definitions/rule-constants";

import { goToLogin } from "../../_lib/api-client";
import { type FormErrors, NO_ERRORS, apiErrors } from "../../_lib/ledger-ui";
import { insightsHref } from "../../_lib/insights-ui";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

type Row = { id: number; type: RuleType; value: string };
type Option = Readonly<{ id: string; name: string }>;

const NAME_MAX = 80;
const MIN_VALUE = 2;

let nextId = 1;
const row = (type: RuleType = "token", value = ""): Row => ({ id: nextId++, type, value });

/**
 * Generatorul pe articole (F10-B; ADR 0023): regulile de potrivire pe numele produselor
 * (include/exclude, `exact`/`prefix`/`contains`/`token`, ȘI/SAU plat), tipurile de linii și
 * filtrele opționale pe categorie/etichetă. «Previzualizează» rulează regulile fără să salveze
 * (`POST /api/v1/report-definitions/preview`); «Salvează» creează raportul (`Idempotency-Key`).
 * Valorile se normalizează pe server (litere mici, fără diacritice).
 */
export function ReportGenerator({
  initial,
  categories,
  tags,
}: Readonly<{
  initial: DefinitionJson | null;
  categories: readonly Option[];
  tags: readonly Option[];
}>) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const t = ro.insights.generator;
  const rules = initial?.rules;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [combine, setCombine] = useState<"any" | "all">(rules?.combine ?? "any");
  const [include, setInclude] = useState<Row[]>(
    rules ? rules.include.map((x) => row(x.type, x.value)) : [row()],
  );
  const [exclude, setExclude] = useState<Row[]>(
    rules ? rules.exclude.map((x) => row(x.type, x.value)) : [],
  );
  const [kinds, setKinds] = useState<readonly LineKindFilter[]>(rules?.kinds ?? DEFAULT_KINDS);
  const [categoryIds, setCategoryIds] = useState<readonly string[]>(rules?.categoryIds ?? []);
  const [tagIds, setTagIds] = useState<readonly string[]>(rules?.tagIds ?? []);
  const [period, setPeriod] = useState<ReportPeriod>("all");
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [info, setInfo] = useState<string | null>(null);
  const [preview, setPreview] = useState<RunJson | null>(null);
  const busy = pending || !hydrated;

  const toggle = <T extends string>(list: readonly T[], value: T, max: number): T[] =>
    list.includes(value) ? list.filter((x) => x !== value) : [...list, value].slice(0, max);

  function payloadRules() {
    const clean = (rows: Row[]) =>
      rows.map((r) => ({ type: r.type, value: r.value.trim() })).filter((r) => r.value !== "");
    return {
      v: 1,
      combine,
      include: clean(include),
      exclude: clean(exclude),
      kinds,
      categoryIds,
      tagIds,
    };
  }

  function validate(requireName: boolean): boolean {
    const fields: Record<string, string> = {};
    if (requireName && name.trim() === "") fields.name = t.nameRequired;
    const short = [...include, ...exclude].some((r) => {
      const v = r.value.trim();
      return v !== "" && r.type !== "exact" && v.length < MIN_VALUE;
    });
    if (short) fields.rules = t.valueRequired;
    if (kinds.length === 0) fields.kinds = ro.ledger.errors.invalid;
    if (Object.keys(fields).length > 0) {
      setErrors({ form: ro.ledger.errors.invalid, fields });
      return false;
    }
    setErrors(NO_ERRORS);
    return true;
  }

  async function runPreview() {
    setInfo(null);
    if (!validate(false)) return;
    const result = await submit<RunJson>("/api/v1/report-definitions/preview", "POST", {
      rules: payloadRules(),
      period,
    });
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setPreview(null);
      setErrors(result.status === 429 ? { form: t.rateLimited, fields: {} } : apiErrors(result));
      return;
    }
    setPreview(result.data);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInfo(null);
    if (!validate(true)) return;
    const result = await submit<DefinitionJson>(
      "/api/v1/report-definitions",
      "POST",
      {
        name: name.trim(),
        description: description.trim() === "" ? null : description.trim(),
        rules: payloadRules(),
      },
      { idempotent: true },
    );
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setErrors(apiErrors(result));
      return;
    }
    setInfo(t.saved);
    router.push(insightsHref({ report: result.data!.id }, "rapoarte"));
    router.refresh();
  }

  function rules_editor(
    title: string,
    emptyText: string,
    prefix: string,
    rows: Row[],
    set: (rows: Row[]) => void,
  ) {
    return (
      <fieldset className="flex flex-col gap-2" data-testid={`${prefix}-rules`}>
        <legend className="mb-1 font-semibold">{title}</legend>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">{emptyText}</p> : null}
        {rows.map((r, i) => (
          <div key={r.id} className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-36 flex-col gap-1.5">
              <Label htmlFor={`${prefix}-type-${r.id}`}>
                {t.ruleType} {i + 1}
              </Label>
              <Select
                id={`${prefix}-type-${r.id}`}
                value={r.type}
                onChange={(e) =>
                  set(
                    rows.map((x) =>
                      x.id === r.id ? { ...x, type: e.target.value as RuleType } : x,
                    ),
                  )
                }
              >
                {RULE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t.types[type]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex min-w-40 grow flex-col gap-1.5">
              <Label htmlFor={`${prefix}-value-${r.id}`}>
                {t.ruleValue} {i + 1}
              </Label>
              <Input
                id={`${prefix}-value-${r.id}`}
                value={r.value}
                maxLength={60}
                autoComplete="off"
                onChange={(e) =>
                  set(rows.map((x) => (x.id === r.id ? { ...x, value: e.target.value } : x)))
                }
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => set(rows.filter((x) => x.id !== r.id))}
              aria-label={`${t.removeRule} ${i + 1}`}
            >
              {t.removeRule}
            </Button>
          </div>
        ))}
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={rows.length >= MAX_TERMS}
            onClick={() => set([...rows, row()])}
            data-testid={`${prefix}-add`}
          >
            {t.addRule}
          </Button>
          {rows.length >= MAX_TERMS ? (
            <span className="ml-2 text-sm text-muted-foreground">{t.limitHint(MAX_TERMS)}</span>
          ) : null}
        </div>
      </fieldset>
    );
  }

  return (
    <form
      onSubmit={(e) => void save(e)}
      noValidate
      className="flex flex-col gap-5"
      data-testid="report-generator"
    >
      <p className="text-sm text-muted-foreground">{t.intro}</p>
      {initial ? <Alert tone="info">{t.prefilled}</Alert> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <Field id="gen-name" label={t.name} error={errors.fields.name}>
          {(p) => (
            <Input
              id={p.id}
              aria-describedby={p.describedBy}
              aria-invalid={p.invalid || undefined}
              value={name}
              maxLength={NAME_MAX}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field id="gen-description" label={t.description} optional={t.optional}>
          {(p) => (
            <Input
              id={p.id}
              aria-describedby={p.describedBy}
              value={description}
              maxLength={500}
              autoComplete="off"
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="gen-combine">{t.combine}</Label>
        <Select
          id="gen-combine"
          value={combine}
          onChange={(e) => setCombine(e.target.value as "any" | "all")}
          className="max-w-sm"
        >
          <option value="any">{t.combineAny}</option>
          <option value="all">{t.combineAll}</option>
        </Select>
      </div>
      {rules_editor(t.include, t.noInclude, "include", include, setInclude)}
      {rules_editor(t.exclude, t.noExclude, "exclude", exclude, setExclude)}
      {errors.fields.rules ? (
        <p className="text-sm text-bad" role="alert">
          {errors.fields.rules}
        </p>
      ) : null}
      <fieldset className="flex flex-wrap gap-x-5 gap-y-2" data-testid="kinds">
        <legend className="mb-1 font-semibold">{t.kinds}</legend>
        {LINE_KINDS.map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={kinds.includes(k)}
              onChange={() => setKinds(toggle(kinds, k, LINE_KINDS.length))}
              className="size-4"
            />
            {t.kindLabels[k]}
          </label>
        ))}
        {errors.fields.kinds ? (
          <p className="w-full text-sm text-bad">{errors.fields.kinds}</p>
        ) : null}
      </fieldset>
      {categories.length > 0 || tags.length > 0 ? (
        <details className="rounded-md border border-border px-4 py-3">
          <summary className="cursor-pointer font-medium text-primary">{t.advanced}</summary>
          <div className="mt-3 flex flex-col gap-4">
            {categories.length > 0 ? (
              <fieldset className="flex flex-wrap gap-x-5 gap-y-2">
                <legend className="mb-1 font-semibold">{t.categoriesFilter}</legend>
                {categories.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={categoryIds.includes(c.id)}
                      onChange={() => setCategoryIds(toggle(categoryIds, c.id, MAX_FILTER_IDS))}
                      className="size-4"
                    />
                    {c.name}
                  </label>
                ))}
              </fieldset>
            ) : null}
            {tags.length > 0 ? (
              <fieldset className="flex flex-wrap gap-x-5 gap-y-2">
                <legend className="mb-1 font-semibold">{t.tagsFilter}</legend>
                {tags.map((x) => (
                  <label key={x.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={tagIds.includes(x.id)}
                      onChange={() => setTagIds(toggle(tagIds, x.id, MAX_FILTER_IDS))}
                      className="size-4"
                    />
                    {x.name}
                  </label>
                ))}
              </fieldset>
            ) : null}
          </div>
        </details>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="gen-period">{ro.insights.periodLabel}</Label>
          <Select
            id="gen-period"
            value={period}
            onChange={(e) => setPeriod(e.target.value as ReportPeriod)}
          >
            {REPORT_PERIODS.map((p) => (
              <option key={p} value={p}>
                {ro.insights.periods[p]}
              </option>
            ))}
          </Select>
        </div>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void runPreview()}
          data-testid="gen-preview"
        >
          {pending ? t.previewing : t.preview}
        </Button>
        <Button type="submit" disabled={busy} data-testid="gen-save">
          {pending ? t.saving : t.save}
        </Button>
      </div>
      <Alert>{errors.form}</Alert>
      <Alert tone="ok">{info}</Alert>
      {preview ? (
        <section aria-label={t.previewTitle} className="rounded-md border border-border p-4">
          <h3 className="mb-3 text-lg font-bold">
            {t.previewTitle} · {ro.insights.estimate}
          </h3>
          <ReportResult result={preview} testId="preview" />
        </section>
      ) : null}
    </form>
  );
}
