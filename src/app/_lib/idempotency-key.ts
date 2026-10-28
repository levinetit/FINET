/**
 * Cheia `Idempotency-Key` a unui formular (ADR 0005, F2-C): una per trimitere logică.
 *
 * - Prima trimitere a unui corp generează o cheie nouă (UUID v4: 36 de caractere din
 *   `[0-9a-f-]`, în limita serverului de 16–128 caractere `[A-Za-z0-9_-]`).
 * - Cheia se PĂSTREAZĂ doar pentru reîncercarea ACELUIAȘI corp după o eroare de rețea, un 5xx sau
 *   409 `request_in_progress`: serverul fie nu a memorat nimic, fie răspunde cu reluarea.
 * - Cheia se ARUNCĂ după un 2xx sau după orice alt 4xx: serverul a memorat răspunsul, iar o cerere
 *   corectată cu aceeași cheie ar primi 422 (`idempotency_key_reused`).
 * - Un corp diferit înseamnă o cerere nouă, deci o cheie nouă.
 *
 * Funcții pure (fără React), testate în `idempotency-key.test.ts`.
 */

export type KeyState = Readonly<{ key: string; body: string }> | null;

/** Generatorul implicit: `crypto.randomUUID()` (browser și Node 24). */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** Cheia pentru corpul `body` (JSON serializat): cea păstrată dacă e același corp, altfel una nouă. */
export function keyFor(
  state: KeyState,
  body: string,
  generate: () => string = newIdempotencyKey,
): Readonly<{ key: string; state: NonNullable<KeyState> }> {
  if (state && state.body === body) return { key: state.key, state };
  const next = { key: generate(), body };
  return { key: next.key, state: next };
}

/** Starea după răspuns: `status` 0 = eroare de rețea. */
export function afterResponse(
  state: KeyState,
  status: number,
  errorCode: string | null | undefined,
): KeyState {
  const retryable =
    status === 0 || status >= 500 || (status === 409 && errorCode === "request_in_progress");
  return retryable ? state : null;
}
