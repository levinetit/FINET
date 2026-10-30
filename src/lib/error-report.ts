/**
 * Raportarea erorilor interfeței către panoul de administrare (Faza 11-B, ADR 0028), doar în modul
 * `saas` (în `personal` ruta răspunde 404 și cererea se ignoră). Se trimite DOAR forma rutei
 * (id-urile devin `[id]`), numele erorii (fără mesaj, fără stivă) și digest-ul Next: nicio dată a
 * utilizatorului. Fire-and-forget: o eroare la raportare nu produce alte erori.
 */
const SEGMENT_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i;

/** `/transactions/6f1c…` → `/transactions/[id]`; orice caracter în afara setului permis → `/`. */
export function routePattern(pathname: string): string {
  const path = pathname.split("?")[0]!.split("#")[0]!;
  const out = path
    .split("/")
    .map((segment) => (SEGMENT_ID.test(segment) ? "[id]" : segment))
    .join("/");
  return /^\/[A-Za-z0-9/_[\]-]{0,199}$/.test(out) ? out : "/";
}

/** Numele erorii redus la forma acceptată de server (`TypeError`, `Error`…); implicit `ClientError`. */
export function errorCode(error: { name?: string }): string {
  const name = error.name ?? "";
  return /^[A-Za-z0-9_.:-]{1,60}$/.test(name) ? name : "ClientError";
}

export function reportClientError(
  error: { name?: string; digest?: string },
  pathname: string,
): void {
  try {
    const body: Record<string, string> = {
      kind: "client",
      route: routePattern(pathname),
      code: errorCode(error),
    };
    if (error.digest && /^[A-Za-z0-9_-]{1,40}$/.test(error.digest)) body.digest = error.digest;
    void fetch("/api/v1/errors", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // raportarea nu trebuie să strice nimic
  }
}
