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

// ---------------------------------------------------------------------------------------------
// Zile calendaristice și recurențe (Faza 5, ADR 0011). Toate calculele sunt pe cifre (zile de la
// 1970-01-01 prin `Date.UTC`), fără fus orar: o dată `YYYY-MM-DD` nu are oră, deci trecerile la
// ora de vară/iarnă nu o pot deplasa. Fusul orar contează doar pentru „azi” (`localDateOf`).
// ---------------------------------------------------------------------------------------------

/** Data calendaristică `YYYY-MM-DD` (1900–2999). */
export type CalendarDate = string;

export const MIN_DATE: CalendarDate = "1900-01-01";
export const MAX_DATE: CalendarDate = "2999-12-31";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function dateParts(date: CalendarDate): [number, number, number] {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError("Data trebuie să fie de forma AAAA-LL-ZZ.");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) {
    throw new RangeError("Data nu există în calendar.");
  }
  return [y, mo, d];
}

function ymd(y: number, mo: number, d: number): CalendarDate {
  return `${pad(y, 4)}-${pad(mo)}-${pad(d)}`;
}

/** Numărul zilei (zile de la 1970-01-01). */
export function dayNumber(date: CalendarDate): number {
  const [y, mo, d] = dateParts(date);
  return Date.UTC(y, mo - 1, d) / DAY_MS;
}

/** Data zilei cu numărul `n`. */
export function fromDayNumber(n: number): CalendarDate {
  const t = new Date(n * DAY_MS);
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Data deplasată cu `n` zile. */
export function addDays(date: CalendarDate, n: number): CalendarDate {
  return fromDayNumber(dayNumber(date) + n);
}

/** Ziua `day` din luna `y-mo`, limitată la ultima zi a lunii (31 → 30/29/28). */
function clampedDay(y: number, mo: number, day: number): CalendarDate {
  return ymd(y, mo, Math.min(day, new Date(Date.UTC(y, mo, 0)).getUTCDate()));
}

export type RecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly";

/**
 * Regula de recurență: ancora e `startOn` (ziua pentru zilnic/săptămânal, luna pentru lunar,
 * luna și anul pentru anual), iar `dayOfMonth` e ziua țintă la lunar/anual. Ziua țintă NU se
 * deplasează după o lună scurtă: 31 ian → 28/29 feb → 31 mar; 29 feb → 28 feb în anii nebisecți.
 */
export type RecurrenceSpec = Readonly<{
  frequency: RecurrenceFrequency;
  interval: number;
  dayOfMonth: number | null;
  startOn: CalendarDate;
}>;

/** A `n`-a dată a grilei regulii (n ≥ 0), fără a ține cont de `startOn` ca limită inferioară. */
export function gridDate(spec: RecurrenceSpec, n: number): CalendarDate {
  const [y, mo, d] = dateParts(spec.startOn);
  switch (spec.frequency) {
    case "daily":
      return addDays(spec.startOn, n * spec.interval);
    case "weekly":
      return addDays(spec.startOn, n * spec.interval * 7);
    case "monthly": {
      const index = y * 12 + (mo - 1) + n * spec.interval;
      return clampedDay(Math.floor(index / 12), (index % 12) + 1, spec.dayOfMonth ?? d);
    }
    case "yearly":
      return clampedDay(y + n * spec.interval, mo, spec.dayOfMonth ?? d);
  }
}

/**
 * Prima scadență a regulii ≥ `from` (și ≥ `startOn`), sau `null` dacă depășește 2999-12-31.
 * Calculul e direct (estimare + cel mult câțiva pași), nu o parcurgere de la început.
 */
export function occurrenceOnOrAfter(spec: RecurrenceSpec, from: CalendarDate): CalendarDate | null {
  if (!Number.isInteger(spec.interval) || spec.interval < 1) {
    throw new RangeError("Intervalul trebuie să fie un întreg ≥ 1.");
  }
  const target = from > spec.startOn ? from : spec.startOn;
  if (target > MAX_DATE) return null;
  let n: number;
  if (spec.frequency === "daily" || spec.frequency === "weekly") {
    const step = spec.interval * (spec.frequency === "weekly" ? 7 : 1);
    n = Math.ceil((dayNumber(target) - dayNumber(spec.startOn)) / step);
  } else {
    const [sy, sm] = dateParts(spec.startOn);
    const [ty, tm] = dateParts(target);
    const units = spec.frequency === "monthly" ? ty * 12 + tm - (sy * 12 + sm) : ty - sy;
    n = Math.max(0, Math.floor(units / spec.interval) - 1);
  }
  let date = gridDate(spec, n);
  while (date < target) {
    n += 1;
    date = gridDate(spec, n);
  }
  return date > MAX_DATE ? null : date;
}

/** Scadența de după `date` (strict mai târziu), sau `null` după 2999-12-31. */
export function occurrenceAfter(spec: RecurrenceSpec, date: CalendarDate): CalendarDate | null {
  if (date >= MAX_DATE) return null;
  return occurrenceOnOrAfter(spec, addDays(date, 1));
}

/** Data deplasată cu `n` ani (negativ = în urmă); 29 februarie → 28 în anii nebisecți. */
export function addYears(date: CalendarDate, n: number): CalendarDate {
  const [y, mo, d] = dateParts(date);
  return clampedDay(y + n, mo, d);
}

/**
 * Câte scadențe are regula în intervalul [`startOn`, `until`], numărând cel mult `cap + 1`
 * (suficient ca apelantul să știe că pragul e depășit, fără a parcurge tot intervalul).
 */
export function countOccurrencesUntil(
  spec: RecurrenceSpec,
  until: CalendarDate,
  cap: number,
): number {
  let n = 0;
  let d = occurrenceOnOrAfter(spec, spec.startOn);
  while (d !== null && d <= until && n <= cap) {
    n += 1;
    d = occurrenceAfter(spec, d);
  }
  return n;
}
