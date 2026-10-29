"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ro } from "@/messages/ro";

import { apiFetch, goToLogin } from "../../_lib/api-client";
import {
  type MappingForm,
  formFromSuggestion,
  mappingFromForm,
  statementErrorText,
} from "../../_lib/statements-ui";
import { CLIENT_HEADER_NAME, clientHeaderFor } from "../../_lib/usage-client";
import { useHydrated } from "../../_lib/use-hydrated";

export type ImportAccount = Readonly<{ id: string; name: string; currency: string }>;

type Upload = Readonly<{
  id: string;
  status: string;
  errorCode: string | null;
  importId: string | null;
}>;
type Part =
  | Readonly<{ index: number; kind: "queued"; upload: Upload; duplicate: boolean }>
  | Readonly<{
      index: number;
      kind: "preview";
      import: { id: string; status: string };
      alreadyImported: boolean;
    }>
  | Readonly<{
      index: number;
      kind: "mapping_required";
      columnCount: number;
      sample: string[][];
      suggestion: {
        mapping: Record<string, unknown>;
        template: { bank: string } | null;
      };
    }>
  | Readonly<{ index: number; kind: "rejected"; code: string }>;

const ENDPOINT = "/api/v1/statements/uploads";
const ACCEPT = ".pdf,.csv,.txt,.xlsx,.zip,application/pdf,text/csv,application/zip";
const POLL_MS = 3000;
const POLL_MAX = 60;

/**
 * Fluxul extrasului (F7-B): contul → fișierul → (CSV/XLSX) alegerea coloanelor → previzualizarea.
 * Un PDF intră în coada workerului: interfața interoghează starea la 3 s (cel mult 3 minute) și
 * deschide previzualizarea când e gata. Numele fișierului nu se trimite (poate conține date).
 */
export function StatementImport({ accounts }: Readonly<{ accounts: readonly ImportAccount[] }>) {
  const t = ro.statements;
  const router = useRouter();
  const hydrated = useHydrated();
  const ids = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [parts, setParts] = useState<readonly Part[]>([]);
  const [form, setForm] = useState<MappingForm | null>(null);
  const [polling, setPolling] = useState<string | null>(null);

  useEffect(() => {
    if (!polling) return;
    let stop = false;
    let n = 0;
    const tick = async () => {
      if (stop) return;
      const r = await apiFetch<Upload>(`${ENDPOINT}/${polling}`, { method: "GET" });
      if (stop) return;
      if (r.status === 401) return goToLogin();
      if (r.ok && r.data?.status === "parsed" && r.data.importId) {
        setPolling(null);
        router.push(`/statements/${r.data.importId}`);
        return;
      }
      if (r.ok && r.data?.status === "failed") {
        setPolling(null);
        setInfo(null);
        setError(statementErrorText(r.data.errorCode));
        return;
      }
      if (++n >= POLL_MAX) {
        setPolling(null);
        return;
      }
      setTimeout(() => void tick(), POLL_MS);
    };
    const first = setTimeout(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      clearTimeout(first);
    };
  }, [polling, router]);

  async function send(mapping?: Record<string, unknown>) {
    setError(null);
    setInfo(null);
    if (!file || !accountId) return;
    const body = new FormData();
    body.append("accountId", accountId);
    if (mapping) body.append("mapping", JSON.stringify(mapping));
    body.append("file", file, "extras");
    const headers: Record<string, string> = {};
    const client = clientHeaderFor(ENDPOINT);
    if (client) headers[CLIENT_HEADER_NAME] = client;
    setBusy(true);
    try {
      let response: Response;
      try {
        response = await fetch(ENDPOINT, {
          method: "POST",
          body,
          credentials: "same-origin",
          cache: "no-store",
          headers,
        });
      } catch {
        setError(ro.ledger.errors.network);
        return;
      }
      if (response.status === 401) return goToLogin();
      const json = (await response.json().catch(() => null)) as {
        data?: { parts: Part[] };
        error?: { code: string; reason?: string };
      } | null;
      if (!response.ok || !json?.data) {
        const reason = json?.error?.reason ?? json?.error?.code;
        if (response.status === 429) setError(ro.ledger.errors.rateLimited);
        else if (response.status === 404) setError(ro.ledger.errors.notFound);
        else if (response.status === 409)
          setError(ro.ledger.errors.reasons[reason ?? ""] ?? ro.ledger.errors.generic);
        else setError(statementErrorText(reason));
        return;
      }
      const list = json.data.parts;
      setParts(list);
      const mappingPart = list.find((p) => p.kind === "mapping_required");
      setForm(
        mappingPart && mappingPart.kind === "mapping_required"
          ? formFromSuggestion(mappingPart.suggestion.mapping)
          : null,
      );
      if (list.length === 1) {
        const p = list[0]!;
        if (p.kind === "preview" && !p.alreadyImported) router.push(`/statements/${p.import.id}`);
        else if (p.kind === "preview") setInfo(t.alreadyImported);
        else if (p.kind === "queued") {
          setInfo(p.duplicate ? t.duplicateUpload : t.queued);
          setPolling(p.upload.id);
        } else if (p.kind === "rejected") setError(statementErrorText(p.code));
      }
    } finally {
      setBusy(false);
    }
  }

  if (accounts.length === 0) {
    return (
      <Card>
        <p className="text-muted-foreground">
          {t.noAccounts}{" "}
          <Link href="/accounts/new" className="font-semibold text-primary underline">
            {ro.nav.accounts}
          </Link>
        </p>
      </Card>
    );
  }
  const mappingPart = parts.find((p) => p.kind === "mapping_required");
  const disabled = !hydrated || busy || polling !== null;

  return (
    <div className="flex flex-col gap-4">
      <Card aria-labelledby={`${ids}-title`}>
        <CardHeader>
          <CardTitle id={`${ids}-title`}>{t.importTitle}</CardTitle>
          <CardDescription id={`${ids}-hint`}>{t.importHint}</CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium" htmlFor={`${ids}-account`}>
            {t.account}
            <select
              id={`${ids}-account`}
              className="h-11 rounded-md border border-border bg-card px-3"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              data-testid="statement-account"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.currency})
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium" htmlFor={`${ids}-file`}>
            {t.file}
            <input
              ref={fileRef}
              id={`${ids}-file`}
              type="file"
              accept={ACCEPT}
              aria-describedby={`${ids}-hint`}
              className="text-sm"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setParts([]);
                setForm(null);
                setError(null);
                setInfo(null);
              }}
              data-testid="statement-file"
            />
          </label>
          <div>
            <Button
              disabled={disabled || !file}
              onClick={() => void send()}
              data-testid="statement-upload"
            >
              {busy ? t.uploading : t.upload}
            </Button>
          </div>
          <Alert data-testid="statement-error">{error}</Alert>
          <Alert tone="info" data-testid="statement-info">
            {info}
          </Alert>
        </div>
      </Card>

      {parts.length > 1 ? (
        <Card>
          <ul className="flex flex-col gap-2" data-testid="statement-parts">
            {parts.map((p) => (
              <li key={p.index} className="text-sm" data-kind={p.kind}>
                <span className="font-semibold">{t.part(p.index)}: </span>
                {p.kind === "preview" ? (
                  <Link href={`/statements/${p.import.id}`} className="text-primary underline">
                    {p.alreadyImported ? t.alreadyImported : t.openPreview}
                  </Link>
                ) : p.kind === "queued" ? (
                  t.queued
                ) : p.kind === "rejected" ? (
                  statementErrorText(p.code)
                ) : (
                  t.mappingTitle
                )}
              </li>
            ))}
          </ul>
          <Link href="/statements" className={buttonClasses("outline", "sm", "mt-3")}>
            {t.list}
          </Link>
        </Card>
      ) : null}

      {mappingPart && mappingPart.kind === "mapping_required" && form ? (
        <MappingEditor
          part={mappingPart}
          form={form}
          onChange={setForm}
          disabled={disabled}
          onSubmit={() => void send(mappingFromForm(form))}
        />
      ) : null}
    </div>
  );
}

function MappingEditor({
  part,
  form,
  onChange,
  disabled,
  onSubmit,
}: Readonly<{
  part: Extract<Part, { kind: "mapping_required" }>;
  form: MappingForm;
  onChange: (f: MappingForm) => void;
  disabled: boolean;
  onSubmit: () => void;
}>) {
  const t = ro.statements;
  const ids = useId();
  const header = part.sample[Number(form.headerRow) || 0] ?? [];
  const columns = Array.from({ length: part.columnCount }, (_, i) => t.column(i, header[i] ?? ""));
  const set = <K extends keyof MappingForm>(k: K, v: MappingForm[K]) =>
    onChange({ ...form, [k]: v });
  const select = (key: keyof MappingForm, label: string, optional = false) => (
    <label className="flex flex-col gap-1 text-sm font-medium" htmlFor={`${ids}-${key}`}>
      {label}
      <select
        id={`${ids}-${key}`}
        className="h-11 rounded-md border border-border bg-card px-3"
        value={form[key] as string}
        onChange={(e) => set(key, e.target.value as never)}
        data-testid={`mapping-${key}`}
      >
        {optional || form[key] === "" ? <option value="">{t.noColumn}</option> : null}
        {columns.map((c, i) => (
          <option key={i} value={String(i)}>
            {c}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <Card aria-labelledby={`${ids}-title`} data-testid="mapping-editor">
      <CardHeader>
        <CardTitle id={`${ids}-title`}>{t.mappingTitle}</CardTitle>
        <CardDescription>{t.mappingHint}</CardDescription>
      </CardHeader>
      {part.suggestion.template ? (
        <Alert tone="info">{t.template(part.suggestion.template.bank)}</Alert>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">{t.sampleCaption}</caption>
          <tbody>
            {part.sample.map((row, i) => (
              <tr key={i} className="border-b border-border">
                <th scope="row" className="pr-2 text-muted-foreground">
                  {i}
                </th>
                {row.map((cell, j) => (
                  <td key={j} className="pr-3 whitespace-nowrap">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium" htmlFor={`${ids}-hr`}>
          {t.headerRow}
          <input
            id={`${ids}-hr`}
            inputMode="numeric"
            className="h-11 rounded-md border border-border bg-card px-3"
            value={form.headerRow}
            onChange={(e) => set("headerRow", e.target.value)}
          />
        </label>
        {select("date", t.dateCol)}
        <label className="flex flex-col gap-1 text-sm font-medium" htmlFor={`${ids}-df`}>
          {t.dateFormat}
          <select
            id={`${ids}-df`}
            className="h-11 rounded-md border border-border bg-card px-3"
            value={form.dateFormat}
            onChange={(e) => set("dateFormat", e.target.value)}
          >
            {Object.entries(t.dateFormats).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="font-medium">{t.amountMode}</legend>
          {(["signed", "split"] as const).map((m) => (
            <label key={m} className="flex items-center gap-2">
              <input
                type="radio"
                name={`${ids}-mode`}
                checked={form.mode === m}
                onChange={() => set("mode", m)}
              />
              {m === "signed" ? t.amountSigned : t.amountSplit}
            </label>
          ))}
        </fieldset>
        {form.mode === "signed" ? (
          <>
            {select("amount", t.amountCol)}
            <label className="flex flex-col gap-1 text-sm font-medium" htmlFor={`${ids}-neg`}>
              {t.negativeIs}
              <select
                id={`${ids}-neg`}
                className="h-11 rounded-md border border-border bg-card px-3"
                value={form.negativeIs}
                onChange={(e) => set("negativeIs", e.target.value as "debit" | "credit")}
              >
                <option value="debit">{ro.ledger.types.expense}</option>
                <option value="credit">{ro.ledger.types.income}</option>
              </select>
            </label>
          </>
        ) : (
          <>
            {select("debit", t.debitCol)}
            {select("credit", t.creditCol)}
          </>
        )}
        <label className="flex flex-col gap-1 text-sm font-medium" htmlFor={`${ids}-dec`}>
          {t.decimal}
          <select
            id={`${ids}-dec`}
            className="h-11 rounded-md border border-border bg-card px-3"
            value={form.decimal}
            onChange={(e) => set("decimal", e.target.value as "," | ".")}
          >
            <option value=",">,</option>
            <option value=".">.</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium" htmlFor={`${ids}-th`}>
          {t.thousands}
          <select
            id={`${ids}-th`}
            className="h-11 rounded-md border border-border bg-card px-3"
            value={form.thousands}
            onChange={(e) => set("thousands", e.target.value as MappingForm["thousands"])}
          >
            <option value="">{t.none}</option>
            <option value=".">.</option>
            <option value=",">,</option>
            <option value=" ">{t.space}</option>
          </select>
        </label>
        {select("description", t.descriptionCol)}
        {select("reference", t.referenceCol, true)}
        {select("balance", t.balanceCol, true)}
      </div>
      <div className="mt-3">
        <Button disabled={disabled} onClick={onSubmit} data-testid="mapping-apply">
          {t.applyMapping}
        </Button>
      </div>
    </Card>
  );
}
