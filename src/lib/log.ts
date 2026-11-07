/**
 * Jurnalizare structurată (modernizare 2026, pasul O; ADR 0052): o singură linie JSON pe eveniment
 * (`{ time, level, scope, event, ...fields }`), ca workerul (`src/worker/cli.ts`). Regula din
 * master prompt 6.3 rămâne: FĂRĂ date financiare, FĂRĂ identificatori personali, FĂRĂ conținut din
 * cereri; doar coduri scurte, contoare și booleeni. Câmpurile sunt filtrate (string ≤ 200 de
 * caractere, numere, booleeni) ca o greșeală de apelant să nu scurgă structuri întregi.
 *
 * În teste ieșirea se poate capta (`setLogSink`); implicit scrie pe `stderr` pentru `warn`/`error`
 * și pe `stdout` pentru `info`.
 */

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;
export type LogRecord = Readonly<{
  time: string;
  level: LogLevel;
  scope: string;
  event: string;
}> &
  Readonly<Record<string, string | number | boolean | null>>;

type Sink = (record: LogRecord) => void;

const MAX_STRING = 200;
const SCOPE = /^[a-z][a-z0-9_-]{0,31}$/;

function defaultSink(record: LogRecord): void {
  const line = JSON.stringify(record);
  if (record.level === "info") process.stdout.write(`${line}\n`);
  else process.stderr.write(`${line}\n`);
}

let sink: Sink = defaultSink;

/** Doar pentru teste: înlocuiește destinația; întoarce funcția de restaurare. */
export function setLogSink(next: Sink | null): () => void {
  const previous = sink;
  sink = next ?? defaultSink;
  return () => {
    sink = previous;
  };
}

function sanitize(fields: LogFields | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!fields) return out;
  for (const [key, value] of Object.entries(fields)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.]{0,63}$/.test(key) || key === "time" || key === "level") continue;
    if (key === "scope" || key === "event") continue;
    if (value === undefined) continue;
    if (value === null || typeof value === "boolean") out[key] = value;
    else if (typeof value === "number") out[key] = Number.isFinite(value) ? value : null;
    else if (typeof value === "string")
      out[key] = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  return out;
}

function emit(level: LogLevel, scope: string, event: string, fields?: LogFields): void {
  const safeScope = SCOPE.test(scope) ? scope : "app";
  const safeEvent = /^[a-z][a-z0-9_.]{0,63}$/.test(event) ? event : "event";
  sink({
    time: new Date().toISOString(),
    level,
    scope: safeScope,
    event: safeEvent,
    ...sanitize(fields),
  });
}

export const log = Object.freeze({
  info: (scope: string, event: string, fields?: LogFields) => emit("info", scope, event, fields),
  warn: (scope: string, event: string, fields?: LogFields) => emit("warn", scope, event, fields),
  error: (scope: string, event: string, fields?: LogFields) => emit("error", scope, event, fields),
});

/** Codul unei erori (SQLSTATE, `code` al driverului) fără mesaj: mesajele pot conține valori. */
export function errorCodeOf(error: unknown): string {
  let e: unknown = error;
  for (let i = 0; i < 5 && e; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return error instanceof Error && /^[A-Za-z]{1,32}$/.test(error.name) ? error.name : "unknown";
}
