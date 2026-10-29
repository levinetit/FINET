/**
 * Ajutoarele interfeței Import / Bonuri (F6-C, ADR 0015), comune serverului și browserului.
 * Funcții pure, fără React și fără module de server. Sumele DOAR prin `src/lib/money.ts`
 * (`formatMinor`, `parseAmountInput` din `ledger-ui.ts`), niciodată prin float.
 */

import type { Currency } from "@/lib/money";
import { ro } from "@/messages/ro";

import { formatMinor } from "./ledger-ui";

/** Stările unui document după care nu mai are rost să întrebăm serverul (polling oprit). */
export const SETTLED_DOCUMENT_STATUSES: ReadonlySet<string> = new Set([
  "awaiting_consent",
  "needs_review",
  "done",
  "failed",
  "rejected",
]);

export const MAX_FILES = 4;
export const ACCEPTED_TYPES = "image/jpeg,image/png,image/webp,application/pdf";

/**
 * Pauza până la următoarea întrebare (polling „blând”): 3 s, apoi crește cu ~50% la fiecare
 * încercare, plafonată la 20 s; după 40 de încercări (~12 minute, termenul unui document) se
 * oprește (`null`). Fără biblioteci.
 */
export function nextPollDelay(attempt: number): number | null {
  if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt >= 40) return null;
  let delay = 3000;
  for (let i = 0; i < attempt && delay < 20_000; i++) delay = Math.floor((delay * 3) / 2);
  return Math.min(delay, 20_000);
}

/** Mută elementul `i` cu `delta` poziții (reordonarea pozelor bonului lung, cu butoane). */
export function moveItem<T>(list: readonly T[], i: number, delta: number): T[] {
  const j = i + delta;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return [...list];
  const out = [...list];
  const [item] = out.splice(i, 1);
  out.splice(j, 0, item as T);
  return out;
}

export type PickedFile = Readonly<{ name: string; type: string; size: number }>;

/** Verificările din browser înainte de trimitere (serverul le refăce pe toate, după conținut). */
export function selectionProblem(
  files: readonly PickedFile[],
  longReceipt: boolean,
): string | null {
  const t = ro.imports;
  if (files.length === 0) return t.errors.no_files!;
  if (files.length > MAX_FILES) return t.tooMany;
  if (longReceipt) {
    if (files.length < 2) return t.longNeedsParts;
    if (files.some((f) => f.type === "application/pdf")) return t.longNoPdf;
  }
  return null;
}

/** Mesajul unui cod de eroare la încărcare sau la preprocesare (cod stabil → text fix). */
export function documentErrorText(code: string | null | undefined): string {
  const errors = ro.imports.errors;
  return (code ? errors[code] : undefined) ?? errors.generic!;
}

export function documentStatusText(status: string): string {
  return ro.imports.statuses[status] ?? status;
}

export function receiptStatusText(status: string): string {
  return ro.receipts.statuses[status] ?? status;
}

/** Totalul afișat: `45,90 lei`; lipsă → „—”. */
export function formatTotal(totalMinor: number | null, currency: Currency): string {
  return totalMinor === null ? ro.receipts.noTotal : formatMinor(totalMinor, currency);
}

export type IssueLike = Readonly<{ code: string; field?: string; line?: number }>;

/** Textul unei probleme (cod stabil din ADR 0014), cu linia, dacă e cazul. */
export function issueText(issue: IssueLike): string {
  const base = ro.receipts.issueText[issue.code] ?? ro.receipts.issueText.low_confidence!;
  return issue.line === undefined ? base : `${base} (${ro.receipts.issueLine(issue.line)})`;
}

/** Câmpurile și liniile evidențiate pe ecranul de verificare. */
export function highlighted(issues: readonly IssueLike[]): {
  fields: Set<string>;
  lines: Set<number>;
} {
  const fields = new Set<string>();
  const lines = new Set<number>();
  for (const i of issues) {
    if (i.field) fields.add(i.field);
    if (i.line !== undefined) lines.add(i.line);
  }
  return { fields, lines };
}

/** Diferența (cu semn) dintre suma liniilor și total, în unități minore; `null` dacă lipsește. */
export function linesDifference(
  linesSumMinor: number | null,
  totalMinor: number | null,
): number | null {
  if (linesSumMinor === null || totalMinor === null) return null;
  return linesSumMinor - totalMinor;
}

/** Linia bonului trimisă la `PATCH` (forma API-ului). */
export type LinePayload = Readonly<{
  id?: string;
  rawName: string;
  quantity?: string | null;
  unitPriceMinor?: number | null;
  lineTotalMinor: number;
  vatRate?: string | null;
  categoryId?: string | null;
  kind: string;
}>;

/** Suma liniilor (reducerile scad), în întregi: aceeași regulă ca verificarea din cod. */
export function signedLinesSum(lines: readonly Pick<LinePayload, "kind" | "lineTotalMinor">[]) {
  let s = 0;
  for (const l of lines) s += l.kind === "discount" ? -l.lineTotalMinor : l.lineTotalMinor;
  return s;
}

/** Parametrii căutării din `/receipts` → interogarea API (doar valorile cunoscute). */
export function receiptQueryOf(
  params: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const one = (k: string) => {
    const v = params[k];
    return typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 100) : undefined;
  };
  const q = one("q");
  if (q) out.q = q;
  const status = one("status");
  if (status && Object.hasOwn(ro.receipts.statuses, status)) out.status = status;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const categoryId = one("categoryId");
  if (categoryId && uuid.test(categoryId)) out.categoryId = categoryId.toLowerCase();
  const tagId = one("tagId");
  if (tagId && uuid.test(tagId)) out.tagId = tagId.toLowerCase();
  return out;
}
