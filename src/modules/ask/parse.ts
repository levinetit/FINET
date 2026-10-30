import { addDays, addMonths, monthBounds } from "@/lib/calendar";

import type { AskQuery } from "./query";

/**
 * Parserul determinist al întrebărilor în română (F10-C; ADR 0025). Funcție PURĂ: primește
 * întrebarea, data de azi și numele pe care le poate recunoaște (categorii, comercianți ai
 * gospodăriei) și întoarce o interogare din setul închis sau un motiv fix pentru care nu a
 * înțeles. Nu apelează niciun model și nu trimite nimic în afara aplicației.
 *
 * Normalizare: litere mici, fără diacritice (și fără sedilă/virgulă), doar litere și cifre, spații
 * simple. Orice cuvânt necunoscut e ignorat; ce NU se poate deduce NU se presupune în tăcere:
 * perioada lipsă devine luna curentă și e SPUSĂ în `notes`.
 */

export function normalizeText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export type AskNamed = Readonly<{ id: string; name: string; parentId: string | null }>;

export type AskContext = Readonly<{
  /** Data locală de azi (`YYYY-MM-DD`). */
  today: string;
  categories: readonly AskNamed[];
  /** Numele comercianților gospodăriei (cum apar în tranzacții). */
  merchants: readonly string[];
}>;

export type ParseFailure = "empty" | "metric" | "period";

export type ParseResult =
  | Readonly<{ ok: true; query: AskQuery; periodLabel: string; notes: readonly string[] }>
  | Readonly<{ ok: false; reason: ParseFailure }>;

const MONTHS = [
  "ianuarie",
  "februarie",
  "martie",
  "aprilie",
  "mai",
  "iunie",
  "iulie",
  "august",
  "septembrie",
  "octombrie",
  "noiembrie",
  "decembrie",
] as const;

const MONTH_NAMES_RO = [
  "ianuarie",
  "februarie",
  "martie",
  "aprilie",
  "mai",
  "iunie",
  "iulie",
  "august",
  "septembrie",
  "octombrie",
  "noiembrie",
  "decembrie",
] as const;

const pad = (n: number) => String(n).padStart(2, "0");

/** Luni de la începutul săptămânii (luni) pentru o dată. */
function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = duminică
  return addDays(date, -((dow + 6) % 7));
}

export function monthLabel(month: string): string {
  return `${MONTH_NAMES_RO[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;
}

type Period = Readonly<{ from: string; to: string; label: string; defaulted?: boolean }>;

function detectPeriod(n: string, today: string): Period | null {
  const thisMonth = today.slice(0, 7);
  let m: RegExpExecArray | null;

  if ((m = /\bultimele (\d{1,2}) luni\b/.exec(n))) {
    const count = Number(m[1]);
    if (count >= 1 && count <= 24) {
      return {
        from: monthBounds(addMonths(thisMonth, -(count - 1))).from,
        to: today,
        label: count === 1 ? "luna curentă" : `ultimele ${count} luni`,
      };
    }
  }
  if ((m = /\bultimele (\d{1,3}) (?:de )?zile\b/.exec(n))) {
    const count = Number(m[1]);
    if (count >= 1 && count <= 366) {
      return { from: addDays(today, -(count - 1)), to: today, label: `ultimele ${count} zile` };
    }
  }
  if (/\b(?:ultimul an|ultimele 12 luni)\b/.test(n)) {
    return {
      from: monthBounds(addMonths(thisMonth, -11)).from,
      to: today,
      label: "ultimele 12 luni",
    };
  }
  if (/\b(?:astazi|azi)\b/.test(n)) return { from: today, to: today, label: "azi" };
  if (/\bieri\b/.test(n)) {
    const y = addDays(today, -1);
    return { from: y, to: y, label: "ieri" };
  }
  if (/\bsaptamana (?:trecuta|anterioara)\b/.test(n)) {
    const start = addDays(weekStart(today), -7);
    return { from: start, to: addDays(start, 6), label: "săptămâna trecută" };
  }
  if (/\bsaptamana (?:aceasta|asta|curenta)\b/.test(n)) {
    return { from: weekStart(today), to: today, label: "săptămâna aceasta" };
  }
  if (/\b(?:luna|lunii) (?:trecuta|anterioara|precedenta)\b/.test(n)) {
    const month = addMonths(thisMonth, -1);
    const { from, to } = monthBounds(month);
    return { from, to, label: monthLabel(month) };
  }
  if (/\b(?:luna (?:aceasta|asta|curenta|in curs)|in aceasta luna)\b/.test(n)) {
    return { from: monthBounds(thisMonth).from, to: today, label: "luna curentă" };
  }
  if (/\banul (?:trecut|anterior)\b/.test(n)) {
    const year = Number(today.slice(0, 4)) - 1;
    return { from: `${year}-01-01`, to: `${year}-12-31`, label: String(year) };
  }
  if (/\b(?:anul (?:acesta|asta|curent)|in acest an)\b/.test(n)) {
    return { from: `${today.slice(0, 4)}-01-01`, to: today, label: `anul ${today.slice(0, 4)}` };
  }
  // Luni pe nume, cu an opțional. „mai” cere „luna mai”, „in mai” sau un an după el, ca să nu se
  // confunde cu „cel mai mult”.
  for (let i = 0; i < MONTHS.length; i += 1) {
    const name = MONTHS[i]!;
    const base =
      name === "mai"
        ? /\b(?:luna|in|din|pe) mai(?: (20\d{2}))?\b|\bmai (20\d{2})\b/
        : new RegExp(`\\b${name}(?: (20\\d{2}))?\\b`);
    if ((m = base.exec(n))) {
      const explicit = m[1] ?? m[2];
      const monthNo = i + 1;
      let year = explicit ? Number(explicit) : Number(today.slice(0, 4));
      if (!explicit && `${year}-${pad(monthNo)}` > thisMonth) year -= 1;
      const month = `${year}-${pad(monthNo)}`;
      if (year < 2000 || month > thisMonth) return null;
      const { from, to } = monthBounds(month);
      return { from, to: month === thisMonth ? today : to, label: monthLabel(month) };
    }
  }
  if ((m = /\b(?:in|pe) (20\d{2})\b/.exec(n)) || (m = /\banul (20\d{2})\b/.exec(n))) {
    const year = Number(m[1]);
    if (year >= 2000 && year <= Number(today.slice(0, 4))) {
      return {
        from: `${year}-01-01`,
        to: year === Number(today.slice(0, 4)) ? today : `${year}-12-31`,
        label: String(year),
      };
    }
  }
  return null;
}

function detectMetric(n: string): AskQuery["metric"] | null {
  const ranking = /\b(?:top|cele mai mari|cel mai mult|cele mai multe|clasament)\b/.test(n);
  if (ranking) {
    return /\b(?:magazin|magazine|comerciant|comercianti|unde|la ce)\b/.test(n)
      ? "top_merchants"
      : "top_categories";
  }
  if (/\b(?:venit|venituri|incasat|incasari|castigat|salariu|primit)\b/.test(n))
    return "income_total";
  if (
    /\b(?:cheltuit|cheltuiala|cheltuieli|platit|plati|dat pe|consumat|costat|costuri|tranzactii|bonuri)\b/.test(
      n,
    ) ||
    /\bcat am\b/.test(n)
  ) {
    return "expense_total";
  }
  return null;
}

/** Cel mai lung nume (≥ 3 caractere normalizate) care apare ca expresie întreagă în întrebare. */
function longestMatch<T>(n: string, items: readonly T[], nameOf: (t: T) => string): T | null {
  let best: T | null = null;
  let bestLen = 0;
  const padded = ` ${n} `;
  for (const item of items) {
    const name = normalizeText(nameOf(item));
    if (name.length < 3) continue;
    // Potrivire pe cuvânt întreg, cu un „s” opțional (alimente / aliment).
    if (padded.includes(` ${name} `) || padded.includes(` ${name}s `)) {
      if (name.length > bestLen) {
        best = item;
        bestLen = name.length;
      }
    }
  }
  return best;
}

export function parseQuestion(question: string, ctx: AskContext): ParseResult {
  const n = normalizeText(question);
  if (n.length < 3) return { ok: false, reason: "empty" };
  const metric = detectMetric(n);
  if (!metric) return { ok: false, reason: "metric" };

  const notes: string[] = [];
  let period = detectPeriod(n, ctx.today);
  if (!period) {
    // Un an/o lună nerecunoscută („in luna foo”) nu se ghicește; absența completă = luna curentă.
    if (/\b(?:luna|anul|saptamana|ultimele)\b/.test(n)) return { ok: false, reason: "period" };
    const thisMonth = ctx.today.slice(0, 7);
    period = {
      from: monthBounds(thisMonth).from,
      to: ctx.today,
      label: "luna curentă",
      defaulted: true,
    };
    notes.push("Perioada nu a fost menționată: am folosit luna curentă.");
  }

  const query: { -readonly [K in keyof AskQuery]: AskQuery[K] } = {
    metric,
    period: { from: period.from, to: period.to },
  };
  if (!metric.startsWith("top_")) {
    const category = longestMatch(n, ctx.categories, (c) => c.name);
    if (category) query.categoryId = category.id;
    if (metric === "expense_total") {
      const merchant = longestMatch(n, ctx.merchants, (x) => x);
      if (merchant) query.merchant = merchant;
    }
  }
  return { ok: true, query: query as AskQuery, periodLabel: period.label, notes };
}
