/**
 * Calendarul FINET (master prompt 5.2; ADR 0007): luni calendaristice și zile LOCALE.
 *
 * `occurred_on` e o dată locală (`date`, fără oră), deci limitele unei luni sunt pur calendaristice:
 * `YYYY-MM-01` … ultima zi (28/29/30/31), calculate pe `Date.UTC` din cifre, fără fus orar și fără
 * DST. Fusul orar contează DOAR pentru „azi” / „luna curentă”: un moment (UTC) se transformă în
 * data locală a gospodăriei (`households.timezone`, implicit `Europe/Bucharest`) cu `Intl`, deci
 * 31 dec 22:30 UTC e deja 1 ian în București, iar trecerile la ora de vară/iarnă sunt corecte.
 */

export const DEFAULT_TIME_ZONE = "Europe/Bucharest";

/** Luna calendaristică `YYYY-MM` (1900–2999, ca datele din bază). */
export type Month = string;

const MONTH_RE = /^(\d{4})-(\d{2})$/;

export function isMonth(value: unknown): value is Month {
  if (typeof value !== "string") return false;
  const m = MONTH_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return y >= 1900 && y <= 2999 && mo >= 1 && mo <= 12;
}

function parts(month: Month): [number, number] {
  if (!isMonth(month)) throw new RangeError("Luna trebuie să fie de forma AAAA-LL.");
  const [y, m] = month.split("-");
  return [Number(y), Number(m)];
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Numărul de zile din lună (februarie bisect: 29). */
export function daysInMonth(month: Month): number {
  const [y, m] = parts(month);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Prima și ultima zi a lunii (inclusiv), ca `YYYY-MM-DD`. */
export function monthBounds(month: Month): Readonly<{ from: string; to: string }> {
  const [y, m] = parts(month);
  return {
    from: `${pad(y, 4)}-${pad(m)}-01`,
    to: `${pad(y, 4)}-${pad(m)}-${pad(daysInMonth(month))}`,
  };
}

/** Luna deplasată cu `n` luni (negativ = în urmă). */
export function addMonths(month: Month, n: number): Month {
  const [y, m] = parts(month);
  const index = y * 12 + (m - 1) + n;
  return `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}`;
}

/** Ultimele `count` luni care se termină cu `month`, de la cea mai veche. */
export function monthsEndingAt(month: Month, count: number): Month[] {
  return Array.from({ length: count }, (_, i) => addMonths(month, i - count + 1));
}

/** Toate zilele lunii, `YYYY-MM-DD`, în ordine. */
export function daysOfMonth(month: Month): string[] {
  const [y, m] = parts(month);
  return Array.from(
    { length: daysInMonth(month) },
    (_, i) => `${pad(y, 4)}-${pad(m)}-${pad(i + 1)}`,
  );
}

/** `true` dacă fusul orar e cunoscut de `Intl` (de exemplu `Europe/Bucharest`). */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Data LOCALĂ (`YYYY-MM-DD`) a momentului `instant` în fusul `timeZone`. */
export function localDateOf(instant: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const zone = isTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Luna LOCALĂ curentă (`YYYY-MM`) a momentului `instant` în fusul `timeZone`. */
export function currentMonth(instant: Date, timeZone: string = DEFAULT_TIME_ZONE): Month {
  return localDateOf(instant, timeZone).slice(0, 7);
}
