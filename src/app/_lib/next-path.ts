/**
 * Validarea parametrului `?next=` (unde ajunge utilizatorul după login): DOAR o cale relativă
 * internă. Orice altceva (URL absolut, `//gazdă`, `/\gazdă`, variante codificate, caractere de
 * control, căi spre `/login` sau `/api`) dă pagina implicită. Funcție pură: rulează la fel pe
 * server și în browser, fără open redirect.
 */

export const DEFAULT_AFTER_LOGIN = "/dashboard";

const MAX_LENGTH = 512;
// Caractere de control și spații (inclusiv tab/LF, pe care browserele le elimină din URL-uri).
const UNSAFE_CHARS = /[\u0000-\u0020\u007f-\u009f\u2028\u2029\\]/;
const BASE = "https://finet.invalid";

function decodeFully(value: string): string | null {
  let current = value;
  // Câteva runde: `%252F` → `%2F` → `/`.
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

export function safeNextPath(raw: unknown): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH) {
    return DEFAULT_AFTER_LOGIN;
  }
  if (!value.startsWith("/") || value.startsWith("//") || UNSAFE_CHARS.test(value)) {
    return DEFAULT_AFTER_LOGIN;
  }
  const decoded = decodeFully(value);
  if (decoded === null || decoded.startsWith("//") || UNSAFE_CHARS.test(decoded)) {
    return DEFAULT_AFTER_LOGIN;
  }
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return DEFAULT_AFTER_LOGIN;
  }
  if (url.origin !== BASE) return DEFAULT_AFTER_LOGIN;
  const path = url.pathname.toLowerCase();
  if (
    path === "/login" ||
    path.startsWith("/login/") ||
    path === "/api" ||
    path.startsWith("/api/")
  ) {
    return DEFAULT_AFTER_LOGIN;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Adresa paginii de login care revine la `path` după autentificare. */
export function loginUrlFor(path: string): string {
  return `/login?next=${encodeURIComponent(safeNextPath(path))}`;
}
