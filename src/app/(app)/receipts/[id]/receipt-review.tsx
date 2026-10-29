"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Field } from "@/components/ledger/field";
import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ro } from "@/messages/ro";
import type { ReceiptDetailJson } from "@/modules/receipts/receipts.schema";

import { goToLogin } from "../../../_lib/api-client";
import {
  amountInputValue,
  apiErrors,
  asCurrency,
  formatMinor,
  parseAmountInput,
} from "../../../_lib/ledger-ui";
import {
  type LinePayload,
  formatTotal,
  highlighted,
  issueText,
  signedLinesSum,
} from "../../../_lib/receipts-ui";
import { useHydrated } from "../../../_lib/use-hydrated";
import { useSubmit } from "../../../_lib/use-submit";

export type ReviewDocument = Readonly<{ id: string; mime: string; fileDeleted: boolean }>;
type Option = Readonly<{ id: string; name: string }>;
type AccountOption = Option & Readonly<{ currency: string }>;

type LineState = {
  key: string;
  id?: string;
  rawName: string;
  quantity: string;
  unitPrice: string;
  total: string;
  vatRate: string;
  categoryId: string;
  kind: string;
};

const LINE_KINDS = ["product", "discount", "deposit_sgr", "bag", "other"] as const;
const PAYMENT_METHODS = ["cash", "card", "voucher", "mixed", "other"] as const;

let lineSeq = 0;

function lineStateOf(
  l: ReceiptDetailJson["lines"][number],
  currency: ReturnType<typeof asCurrency>,
): LineState {
  return {
    key: `l${++lineSeq}`,
    id: l.id,
    rawName: l.rawName,
    quantity: l.quantity === null ? "" : l.quantity.replace(/\.?0+$/, "").replace(".", ","),
    unitPrice: l.unitPriceMinor === null ? "" : amountInputValue(l.unitPriceMinor, currency),
    total: amountInputValue(l.lineTotalMinor, currency),
    vatRate: l.vatRate === null ? "" : l.vatRate.replace(/\.00$/, "").replace(".", ","),
    categoryId: l.categoryId ?? "",
    kind: l.kind,
  };
}

/**
 * Ecranul de verificare (ADR 0015). Toate sumele se citesc și se scriu prin `money.ts`
 * (`parseAmountInput` → `…Minor` întreg); nimic nu se calculează în float. „Confirmă și salvează”
 * trimite întâi corecturile (dacă există), apoi confirmarea cu `Idempotency-Key`.
 */
export function ReceiptReview({
  receipt: initial,
  documents,
  accounts,
  categories,
}: Readonly<{
  receipt: ReceiptDetailJson;
  documents: readonly ReviewDocument[];
  accounts: readonly AccountOption[];
  categories: readonly Option[];
}>) {
  const t = ro.receipts;
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [receipt, setReceipt] = useState(initial);
  const currency = asCurrency(receipt.currency);
  const [fields, setFields] = useState(() => ({
    merchantName: initial.merchantName ?? "",
    merchantTaxId: initial.merchantTaxId ?? "",
    receiptNumber: initial.receiptNumber ?? "",
    occurredOn: initial.occurredOn ?? "",
    paymentMethod: initial.paymentMethod ?? "",
    total: initial.totalMinor === null ? "" : amountInputValue(initial.totalMinor, currency),
    vatTotal:
      initial.vatTotalMinor === null ? "" : amountInputValue(initial.vatTotalMinor, currency),
  }));
  const [lines, setLines] = useState<LineState[]>(() =>
    initial.lines.map((l) => lineStateOf(l, currency)),
  );
  const [dirty, setDirty] = useState(false);
  const sameCurrency = accounts.filter((a) => a.currency === receipt.currency);
  const [accountId, setAccountId] = useState(sameCurrency[0]?.id ?? "");
  const [txCategory, setTxCategory] = useState<string>("auto");
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const saved = receipt.status === "saved";
  const marks = highlighted(receipt.issues);
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  const setField = (name: keyof typeof fields, value: string) => {
    setFields((f) => ({ ...f, [name]: value }));
    setDirty(true);
  };
  const setLine = (key: string, patch: Partial<LineState>) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    setDirty(true);
  };

  /** Corpul `PATCH` din formular, sau erorile pe câmp (sumele parsate prin `money.ts`). */
  function buildPatch(): { body: Record<string, unknown> } | { errors: Record<string, string> } {
    const errs: Record<string, string> = {};
    const amount = (key: string, text: string, required: boolean): number | null => {
      if (text.trim() === "") {
        if (required) errs[key] = ro.ledger.amountErrors.empty!;
        return null;
      }
      const r = parseAmountInput(text, currency);
      if (!r.ok) {
        errs[key] = r.message;
        return null;
      }
      return r.amountMinor;
    };
    const total = amount("total", fields.total, false);
    const vatTotal = amount("vatTotal", fields.vatTotal, false);
    const payload: LinePayload[] = [];
    lines.forEach((l, i) => {
      const lineTotal = amount(`lines.${i}.lineTotalMinor`, l.total, true);
      const unit = amount(`lines.${i}.unitPriceMinor`, l.unitPrice, false);
      if (l.rawName.trim() === "") errs[`lines.${i}.rawName`] = t.line.name;
      payload.push({
        ...(l.id ? { id: l.id } : {}),
        rawName: l.rawName,
        quantity: l.quantity.trim() === "" ? null : l.quantity.trim(),
        unitPriceMinor: unit,
        lineTotalMinor: lineTotal ?? 0,
        vatRate: l.vatRate.trim() === "" ? null : l.vatRate.trim(),
        categoryId: l.kind === "product" && l.categoryId !== "" ? l.categoryId : null,
        kind: l.kind,
      });
    });
    if (Object.keys(errs).length > 0) return { errors: errs };
    return {
      body: {
        merchantName: fields.merchantName,
        merchantTaxId: fields.merchantTaxId.trim() === "" ? null : fields.merchantTaxId,
        receiptNumber: fields.receiptNumber,
        occurredOn: fields.occurredOn === "" ? null : fields.occurredOn,
        paymentMethod: fields.paymentMethod === "" ? null : fields.paymentMethod,
        totalMinor: total,
        vatTotalMinor: vatTotal,
        lines: payload,
      },
    };
  }

  function applyReceipt(next: ReceiptDetailJson) {
    setReceipt(next);
    setLines(next.lines.map((l) => lineStateOf(l, asCurrency(next.currency))));
    setDirty(false);
  }

  async function saveCorrections(): Promise<boolean> {
    setFormError(null);
    setInfo(null);
    const built = buildPatch();
    if ("errors" in built) {
      setErrors(built.errors);
      setFormError(ro.ledger.errors.invalid);
      return false;
    }
    setErrors({});
    const result = await submit<ReceiptDetailJson>(
      `/api/v1/receipts/${receipt.id}`,
      "PATCH",
      built.body,
    );
    if (!result) return false;
    if (result.status === 401) {
      goToLogin();
      return false;
    }
    if (!result.ok || !result.data) {
      const e = apiErrors(result);
      setErrors({ ...e.fields });
      setFormError(e.form);
      return false;
    }
    applyReceipt(result.data);
    setInfo(t.corrected);
    return true;
  }

  async function confirm() {
    if (dirty && !(await saveCorrections())) return;
    setFormError(null);
    setInfo(null);
    const body: Record<string, unknown> = { accountId };
    if (txCategory !== "auto") body.categoryId = txCategory === "" ? null : txCategory;
    if (receipt.duplicateOfReceiptId !== null) body.allowDuplicate = allowDuplicate;
    const result = await submit<{ receipt: ReceiptDetailJson; transactionId: string }>(
      `/api/v1/receipts/${receipt.id}/confirm`,
      "POST",
      body,
      { idempotent: true },
    );
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok || !result.data) {
      const e = apiErrors(result);
      setErrors({ ...e.fields });
      setFormError(e.form);
      return;
    }
    applyReceipt(result.data.receipt);
    setInfo(t.confirmed);
    router.refresh();
  }

  async function reprocess(order?: readonly number[]) {
    setFormError(null);
    setInfo(null);
    const result = await submit(
      `/api/v1/receipts/${receipt.id}/reprocess`,
      "POST",
      order ? { order } : undefined,
    );
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setFormError(apiErrors(result).form);
      return;
    }
    router.push("/import");
  }

  // Suma liniilor, din formular (întregi, prin `parseAmountInput`); `null` dacă un total e invalid.
  const parsedLines = lines.map((l) => {
    const r = parseAmountInput(l.total, currency);
    return r.ok ? { kind: l.kind, lineTotalMinor: r.amountMinor } : null;
  });
  const linesSum =
    parsedLines.every((x) => x !== null) && parsedLines.length > 0
      ? signedLinesSum(parsedLines as { kind: string; lineTotalMinor: number }[])
      : null;
  const totalParsed = fields.total.trim() === "" ? null : parseAmountInput(fields.total, currency);
  const totalMinor = totalParsed && totalParsed.ok ? totalParsed.amountMinor : null;
  const diff = linesSum !== null && totalMinor !== null ? linesSum - totalMinor : null;
  const disabled = !hydrated || pending || saved;

  const fieldClass = (name: string) =>
    marks.fields.has(name) ? "rounded-md bg-warn-soft p-1" : undefined;

  return (
    <div className="flex flex-col gap-4">
      {receipt.duplicateOfReceiptId !== null ? (
        <Alert tone="info" data-testid="duplicate-banner">
          {t.duplicateBanner}{" "}
          <Link
            href={`/receipts/${receipt.duplicateOfReceiptId}`}
            className="font-semibold text-primary underline"
          >
            {t.duplicateLink}
          </Link>
          .
        </Alert>
      ) : null}
      {receipt.suggestedOrder ? (
        <Alert tone="info" data-testid="order-banner">
          {t.orderBanner}{" "}
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => void reprocess(receipt.suggestedOrder ?? undefined)}
          >
            {t.autoOrder}
          </Button>
        </Alert>
      ) : null}
      {saved ? (
        <Alert tone="ok" data-testid="saved-note">
          {t.savedNote}{" "}
          {receipt.transactionId ? (
            <Link
              href={`/transactions/${receipt.transactionId}`}
              className="font-semibold text-primary underline"
              data-testid="open-transaction"
            >
              {t.openTransaction}
            </Link>
          ) : null}
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card aria-labelledby="images-title">
          <CardHeader>
            <CardTitle id="images-title">{t.images}</CardTitle>
          </CardHeader>
          <ul className="flex flex-col gap-3">
            {documents.map((d, i) => (
              <li key={d.id}>
                {d.fileDeleted ? (
                  <p className="text-sm text-muted-foreground">{t.fileDeleted}</p>
                ) : d.mime === "application/pdf" ? (
                  <a
                    href={`/api/v1/documents/${d.id}/file`}
                    className={buttonClasses("outline", "sm")}
                  >
                    {t.pdfLink}
                  </a>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element -- fișierul vine doar din ruta autentificată (`no-store`), nu prin optimizatorul Next
                  <img
                    src={`/api/v1/documents/${d.id}/file`}
                    alt={t.imageAlt(i + 1, documents.length)}
                    className="w-full rounded border border-border"
                    loading="lazy"
                  />
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-muted-foreground" data-testid="provider">
            {t.provider[receipt.providerUsed] ?? ""}
            {receipt.fallbackReason
              ? ` ${t.fallbackPrefix}${t.fallback[receipt.fallbackReason] ?? ""}.`
              : ""}
          </p>
          {receipt.confidence !== null ? (
            <p className="text-sm text-muted-foreground">{t.confidence(receipt.confidence)}</p>
          ) : null}
        </Card>

        <div className="flex flex-col gap-4">
          <Card aria-labelledby="issues-title">
            <CardHeader>
              <CardTitle id="issues-title">{t.issues}</CardTitle>
            </CardHeader>
            {receipt.issues.length === 0 ? (
              <p className="text-muted-foreground">{t.noIssues}</p>
            ) : (
              <ul className="list-disc pl-5 text-sm" data-testid="issues">
                {receipt.issues.map((issue, i) => (
                  <li key={`${issue.code}-${i}`} data-code={issue.code}>
                    {issueText(issue)}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card aria-labelledby="fields-title">
            <CardHeader>
              <CardTitle id="fields-title">{t.detailTitle}</CardTitle>
            </CardHeader>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className={fieldClass("merchant")}>
                <Field id="merchantName" label={t.fields.merchantName} error={errors.merchantName}>
                  {(p) => (
                    <Input
                      id={p.id}
                      aria-describedby={p.describedBy}
                      aria-invalid={p.invalid}
                      value={fields.merchantName}
                      maxLength={200}
                      disabled={disabled}
                      onChange={(e) => setField("merchantName", e.target.value)}
                    />
                  )}
                </Field>
              </div>
              <div className={fieldClass("taxId")}>
                <Field
                  id="merchantTaxId"
                  label={t.fields.merchantTaxId}
                  error={errors.merchantTaxId}
                >
                  {(p) => (
                    <Input
                      id={p.id}
                      aria-describedby={p.describedBy}
                      aria-invalid={p.invalid}
                      value={fields.merchantTaxId}
                      maxLength={14}
                      disabled={disabled}
                      onChange={(e) => setField("merchantTaxId", e.target.value)}
                    />
                  )}
                </Field>
              </div>
              <Field id="receiptNumber" label={t.fields.receiptNumber} error={errors.receiptNumber}>
                {(p) => (
                  <Input
                    id={p.id}
                    aria-describedby={p.describedBy}
                    aria-invalid={p.invalid}
                    value={fields.receiptNumber}
                    maxLength={64}
                    disabled={disabled}
                    onChange={(e) => setField("receiptNumber", e.target.value)}
                  />
                )}
              </Field>
              <div className={fieldClass("date")}>
                <Field id="occurredOn" label={t.fields.occurredOn} error={errors.occurredOn}>
                  {(p) => (
                    <Input
                      id={p.id}
                      type="date"
                      aria-describedby={p.describedBy}
                      aria-invalid={p.invalid}
                      value={fields.occurredOn}
                      disabled={disabled}
                      onChange={(e) => setField("occurredOn", e.target.value)}
                    />
                  )}
                </Field>
              </div>
              <div className={fieldClass("total")}>
                <Field
                  id="total"
                  label={t.fields.total}
                  hint={ro.ledger.amountHint}
                  error={errors.total ?? errors.totalMinor}
                >
                  {(p) => (
                    <Input
                      id={p.id}
                      inputMode="decimal"
                      aria-describedby={p.describedBy}
                      aria-invalid={p.invalid}
                      value={fields.total}
                      disabled={disabled}
                      onChange={(e) => setField("total", e.target.value)}
                    />
                  )}
                </Field>
              </div>
              <div className={fieldClass("vatTotal")}>
                <Field
                  id="vatTotal"
                  label={t.fields.vatTotal}
                  optional={ro.ledger.optional}
                  error={errors.vatTotal ?? errors.vatTotalMinor}
                >
                  {(p) => (
                    <Input
                      id={p.id}
                      inputMode="decimal"
                      aria-describedby={p.describedBy}
                      aria-invalid={p.invalid}
                      value={fields.vatTotal}
                      disabled={disabled}
                      onChange={(e) => setField("vatTotal", e.target.value)}
                    />
                  )}
                </Field>
              </div>
              <Field
                id="paymentMethod"
                label={t.fields.paymentMethod}
                optional={ro.ledger.optional}
              >
                {(p) => (
                  <Select
                    id={p.id}
                    value={fields.paymentMethod}
                    disabled={disabled}
                    onChange={(e) => setField("paymentMethod", e.target.value)}
                  >
                    <option value="">—</option>
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {t.paymentMethods[m]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          </Card>
        </div>
      </div>

      <Card aria-labelledby="lines-title">
        <CardHeader>
          <CardTitle id="lines-title">{t.lines}</CardTitle>
        </CardHeader>
        <ol className="flex flex-col gap-3" data-testid="lines">
          {lines.map((l, i) => {
            const flagged = marks.lines.has(i + 1);
            const prefix = `line-${i}`;
            return (
              <li
                key={l.key}
                data-testid="receipt-line"
                data-flagged={flagged ? "true" : "false"}
                className={cn(
                  "grid grid-cols-2 gap-2 rounded-md border p-3 sm:grid-cols-6",
                  flagged ? "border-warn bg-warn-soft" : "border-border",
                )}
              >
                <div className="col-span-2 sm:col-span-2">
                  <Field
                    id={`${prefix}-name`}
                    label={`${i + 1}. ${t.line.name}`}
                    error={errors[`lines.${i}.rawName`]}
                  >
                    {(p) => (
                      <Input
                        id={p.id}
                        aria-describedby={p.describedBy}
                        aria-invalid={p.invalid}
                        value={l.rawName}
                        maxLength={200}
                        disabled={disabled}
                        onChange={(e) => setLine(l.key, { rawName: e.target.value })}
                      />
                    )}
                  </Field>
                </div>
                <Field
                  id={`${prefix}-qty`}
                  label={t.line.quantity}
                  error={errors[`lines.${i}.quantity`]}
                >
                  {(p) => (
                    <Input
                      id={p.id}
                      inputMode="decimal"
                      aria-describedby={p.describedBy}
                      aria-invalid={p.invalid}
                      value={l.quantity}
                      disabled={disabled}
                      onChange={(e) => setLine(l.key, { quantity: e.target.value })}
                    />
                  )}
                </Field>
                <Field
                  id={`${prefix}-unit`}
                  label={t.line.unitPrice}
                  error={errors[`lines.${i}.unitPriceMinor`]}
                >
                  {(p) => (
                    <Input
                      id={p.id}
                      inputMode="decimal"
                      aria-describedby={p.describedBy}
                      aria-invalid={p.invalid}
                      value={l.unitPrice}
                      disabled={disabled}
                      onChange={(e) => setLine(l.key, { unitPrice: e.target.value })}
                    />
                  )}
                </Field>
                <Field
                  id={`${prefix}-total`}
                  label={t.line.total}
                  error={errors[`lines.${i}.lineTotalMinor`]}
                >
                  {(p) => (
                    <Input
                      id={p.id}
                      inputMode="decimal"
                      aria-describedby={p.describedBy}
                      aria-invalid={p.invalid}
                      value={l.total}
                      disabled={disabled}
                      onChange={(e) => setLine(l.key, { total: e.target.value })}
                    />
                  )}
                </Field>
                <Field id={`${prefix}-vat`} label={t.line.vat} error={errors[`lines.${i}.vatRate`]}>
                  {(p) => (
                    <Input
                      id={p.id}
                      inputMode="decimal"
                      aria-describedby={p.describedBy}
                      aria-invalid={p.invalid}
                      value={l.vatRate}
                      disabled={disabled}
                      onChange={(e) => setLine(l.key, { vatRate: e.target.value })}
                    />
                  )}
                </Field>
                <Field id={`${prefix}-kind`} label={t.line.kind}>
                  {(p) => (
                    <Select
                      id={p.id}
                      value={l.kind}
                      disabled={disabled}
                      onChange={(e) => setLine(l.key, { kind: e.target.value })}
                    >
                      {LINE_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {t.lineKinds[k]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <div className="col-span-2 sm:col-span-3">
                  <Field
                    id={`${prefix}-category`}
                    label={t.line.category}
                    error={errors[`lines.${i}.categoryId`]}
                  >
                    {(p) => (
                      <Select
                        id={p.id}
                        value={l.kind === "product" ? l.categoryId : ""}
                        disabled={disabled || l.kind !== "product"}
                        onChange={(e) => setLine(l.key, { categoryId: e.target.value })}
                      >
                        <option value="">{t.line.uncategorized}</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                </div>
                <div className="flex items-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    aria-label={`${t.line.remove} ${i + 1}`}
                    onClick={() => {
                      setLines((ls) => ls.filter((x) => x.key !== l.key));
                      setDirty(true);
                    }}
                  >
                    {t.line.remove}
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
        {!saved ? (
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            disabled={disabled || lines.length >= 500}
            onClick={() => {
              setLines((ls) => [
                ...ls,
                {
                  key: `l${++lineSeq}`,
                  rawName: "",
                  quantity: "",
                  unitPrice: "",
                  total: "",
                  vatRate: "",
                  categoryId: "",
                  kind: "product",
                },
              ]);
              setDirty(true);
            }}
          >
            {t.line.add}
          </Button>
        ) : null}

        {initial.removedLines.length > 0 ? (
          <div className="mt-4">
            <h3 className="font-semibold">{t.removed}</h3>
            <ul className="mt-1 flex flex-col gap-1 text-sm" data-testid="removed-lines">
              {initial.removedLines.map((r) => (
                <li key={`${r.part}-${r.position}`}>
                  <del className="text-muted-foreground">{r.name ?? `${r.part}/${r.position}`}</del>{" "}
                  <span>— {t.removedReason(r.part, r.position)}</span>
                </li>
              ))}
              {initial.removedCount > initial.removedLines.length ? (
                <li>{t.removedMore(initial.removedCount - initial.removedLines.length)}</li>
              ) : null}
            </ul>
          </div>
        ) : null}

        <p className="mt-4 font-medium" data-testid="lines-sum">
          {t.sum(
            linesSum === null ? "—" : formatMinor(linesSum, currency),
            formatTotal(totalMinor, currency),
          )}
        </p>
        {diff !== null ? (
          <p
            className={cn("text-sm", diff === 0 ? "text-ok" : "text-bad")}
            data-testid="lines-diff"
          >
            {diff === 0 ? t.sumOk : t.sumDiff(formatMinor(diff, currency))}
          </p>
        ) : null}
        {!saved ? (
          <div className="mt-3">
            <Button
              variant="secondary"
              disabled={disabled || !dirty}
              onClick={() => void saveCorrections()}
              data-testid="save-corrections"
            >
              {pending ? ro.ledger.saving : t.saveCorrections}
            </Button>
          </div>
        ) : null}
      </Card>

      {!saved ? (
        <Card aria-labelledby="confirm-title">
          <CardHeader>
            <CardTitle id="confirm-title">{t.confirm}</CardTitle>
          </CardHeader>
          {sameCurrency.length === 0 ? (
            <Alert tone="info">{t.noAccounts}</Alert>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id="confirm-account" label={t.account}>
                {(p) => (
                  <Select
                    id={p.id}
                    value={accountId}
                    disabled={disabled}
                    onChange={(e) => setAccountId(e.target.value)}
                  >
                    {sameCurrency.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field id="confirm-category" label={t.transactionCategory}>
                {(p) => (
                  <Select
                    id={p.id}
                    value={txCategory}
                    disabled={disabled}
                    onChange={(e) => setTxCategory(e.target.value)}
                  >
                    <option value="auto">{t.dominant}</option>
                    <option value="">{t.line.uncategorized}</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {categoryName.get(c.id)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {receipt.duplicateOfReceiptId !== null ? (
                <label className="flex cursor-pointer items-center gap-3 sm:col-span-2">
                  <input
                    type="checkbox"
                    className="size-5 accent-[var(--accent)]"
                    checked={allowDuplicate}
                    disabled={disabled}
                    data-testid="not-duplicate"
                    onChange={(e) => setAllowDuplicate(e.target.checked)}
                  />
                  <span>{t.notDuplicate}</span>
                </label>
              ) : null}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              disabled={disabled || accountId === ""}
              onClick={() => void confirm()}
              data-testid="confirm-receipt"
            >
              {pending ? t.confirming : t.confirm}
            </Button>
            <Button
              variant="ghost"
              disabled={disabled}
              onClick={() => void reprocess()}
              title={t.reprocessHint}
            >
              {t.reprocess}
            </Button>
          </div>
        </Card>
      ) : null}
      <Alert>{formError}</Alert>
      <Alert tone="ok">{info}</Alert>
    </div>
  );
}
