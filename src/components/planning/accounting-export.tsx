"use client";

import { useState } from "react";

import { ExportButton } from "@/components/planning/export-button";
import { Alert } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ro } from "@/messages/ro";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPAN_DAYS = 1_100;

function validRange(from: string, to: string): boolean {
  if (!DAY.test(from) || !DAY.test(to) || from > to) return false;
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  return Number.isFinite(span) && span <= MAX_SPAN_DAYS;
}

/**
 * Exportul pentru contabil și lista bonurilor (F10-C, ADR 0024): perioada se alege aici, descărcarea
 * trece prin `ExportButton` (cookie, fără token în URL). Perioada invalidă ascunde butoanele.
 */
export function AccountingExport({
  defaultFrom,
  defaultTo,
}: Readonly<{ defaultFrom: string; defaultTo: string }>) {
  const t = ro.exports.accounting;
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const ok = validRange(from, to);
  const range = new URLSearchParams({ from, to }).toString();
  return (
    <div className="flex flex-col gap-3" data-testid="accounting-export">
      <p className="text-sm text-muted-foreground">{t.hint}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="accounting-from">{t.from}</Label>
          <Input
            id="accounting-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="accounting-to">{t.to}</Label>
          <Input
            id="accounting-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
      </div>
      {ok ? (
        <div className="flex flex-wrap items-start gap-3">
          <ExportButton
            path={`/api/v1/exports/accounting.xlsx?${range}`}
            label={t.xlsx}
            filename="finet-contabilitate.xlsx"
            testId="accounting-xlsx"
          />
          <ExportButton
            path={`/api/v1/exports/accounting.csv?${range}&dialect=ro`}
            label={t.csv}
            filename="finet-contabilitate.csv"
            testId="accounting-csv"
          />
          <ExportButton
            path={`/api/v1/exports/receipts.xlsx?${range}`}
            label={t.listXlsx}
            filename="finet-bonuri.xlsx"
            testId="receipts-xlsx"
          />
          <ExportButton
            path={`/api/v1/exports/receipts.pdf?${range}`}
            label={t.listPdf}
            filename="finet-bonuri.pdf"
            testId="receipts-pdf"
          />
        </div>
      ) : (
        <Alert>{t.invalid}</Alert>
      )}
    </div>
  );
}
