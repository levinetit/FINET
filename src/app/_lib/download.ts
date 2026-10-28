/**
 * Descărcarea unui export CSV din browser (F3-C): `fetch` pe aceeași origine, cu cookie-ul
 * sesiunii (niciodată un token în URL), apoi un `blob` salvat printr-un `<a download>` temporar.
 * Un `<a href>` simplu n-ar putea arăta mesajele cerute pentru 409 `export_too_large` și 429.
 * Răspunsurile de eroare sunt JSON (`{ error: { code, reason } }`), cele reușite `text/csv`.
 */

import { ro } from "@/messages/ro";

import { CLIENT_HEADER_NAME, clientHeaderFor } from "./usage-client";

export type DownloadOutcome =
  Readonly<{ ok: true }> | Readonly<{ ok: false; status: number; message: string }>;

/** Numele fișierului din `Content-Disposition` (`attachment; filename="finet-….csv"`). */
export function filenameOf(header: string | null, fallback: string): string {
  const m = /filename="([A-Za-z0-9._-]{1,100})"/.exec(header ?? "");
  return m ? m[1]! : fallback;
}

/** Mesajul afișat pentru un export eșuat (`status` 0 = rețea). */
export function exportErrorMessage(
  status: number,
  reason: string | undefined,
  retryAfter: number | null,
): string {
  if (status === 0) return ro.ledger.errors.network;
  if (status === 409 && reason === "export_too_large") return ro.exports.tooLarge;
  if (status === 429) {
    return retryAfter ? ro.exports.rateLimitedRetry(retryAfter) : ro.exports.rateLimited;
  }
  if (status === 404) return ro.ledger.errors.notFound;
  return ro.exports.error;
}

/** Descarcă `path` (o rută `/api/v1/exports/*.csv`) ca fișier. */
export async function downloadCsv(path: string, fallbackName: string): Promise<DownloadOutcome> {
  const headers: Record<string, string> = { Accept: "text/csv, application/json" };
  const client = clientHeaderFor(path);
  if (client) headers[CLIENT_HEADER_NAME] = client;
  let response: Response;
  try {
    response = await fetch(path, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers,
    });
  } catch {
    return { ok: false, status: 0, message: exportErrorMessage(0, undefined, null) };
  }
  if (!response.ok) {
    let reason: string | undefined;
    try {
      const body = (await response.json()) as { error?: { reason?: string } };
      reason = body.error?.reason;
    } catch {
      reason = undefined;
    }
    const retry = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
    return {
      ok: false,
      status: response.status,
      message: exportErrorMessage(
        response.status,
        reason,
        Number.isFinite(retry) && retry > 0 ? retry : null,
      ),
    };
  }
  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    return { ok: false, status: 0, message: exportErrorMessage(0, undefined, null) };
  }
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filenameOf(response.headers.get("content-disposition"), fallbackName);
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // Revocarea după ce browserul a preluat descărcarea (în același tick ar putea anula).
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return { ok: true };
}
