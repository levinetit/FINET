/**
 * Codul SQLSTATE și numele constrângerii dintr-o eroare Postgres (postgres.js), inclusiv când e
 * împachetată de Drizzle în `cause`. Nu întoarce mesajul (poate conține valori).
 */
export type PgErrorInfo = Readonly<{ code: string; constraint: string | null }>;

export function pgErrorInfo(error: unknown): PgErrorInfo | null {
  let e: unknown = error;
  for (let i = 0; i < 5 && e && typeof e === "object"; i++) {
    const { code, constraint_name: constraint } = e as {
      code?: unknown;
      constraint_name?: unknown;
    };
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      return { code, constraint: typeof constraint === "string" ? constraint : null };
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}
