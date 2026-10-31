import "server-only";

import { type AccessVerifier, createAccessVerifier, isRequestAllowed } from "@/lib/access";
import { type AccessConfig, getConfig } from "@/lib/config";
import { applySecurityHeaders, buildCsp, createNonce } from "@/lib/security-headers";

/**
 * Decizia Cloudflare Access, comună pentru `src/proxy.ts` și pentru rutele EXCLUSE din
 * `matcher`-ul proxy-ului (Faza 6, ADR 0015: doar `/api/v1/documents`, ca încărcarea să fie citită
 * în flux; cu proxy, Next 16 copiază corpul în memorie și îl trunchiază fără eroare la
 * `proxyClientMaxBodySize`, implicit 10 MB). Aceeași politică, același verificator (cache-ul
 * cheilor JWKS) și aceleași antete de securitate: excluderea din proxy NU slăbește verificarea.
 * FAIL CLOSED: orice eroare (configurație, chei indisponibile) înseamnă „refuzat”.
 */

let verifier: { key: string; verify: AccessVerifier } | null = null;

export function verifierFor(access: AccessConfig): AccessVerifier | null {
  if (!access.teamDomain || !access.aud) return null;
  const key = `${access.teamDomain}\n${access.aud}`;
  if (verifier?.key !== key) {
    verifier = {
      key,
      verify: createAccessVerifier({ teamDomain: access.teamDomain, aud: access.aud }),
    };
  }
  return verifier.verify;
}

/**
 * Căile excluse din proxy (încărcări citite în flux, peste plafonul de 10 MB al proxy-ului):
 * documentele (Faza 6) și extrasele (Faza 7, F7-B). `guardAccess` transmite politicii o cale FIXĂ
 * din această listă (nu calea din URL), ca excepțiile de sănătate/liveness din `isRequestAllowed`
 * să nu se poată aplica niciodată unei rute păzite aici, oricum ar fi scrisă adresa cererii
 * (revizuirea F6-C).
 */
export const PROXY_EXCLUDED_PATHS = ["/api/v1/documents", "/api/v1/statements/uploads"] as const;
export type ProxyExcludedPath = (typeof PROXY_EXCLUDED_PATHS)[number];
export const PROXY_EXCLUDED_PATH: ProxyExcludedPath = PROXY_EXCLUDED_PATHS[0];

/** `true` dacă cererea trece de Access (aceeași funcție ca în proxy), pe calea fixă. */
export async function accessAllowed(
  request: Readonly<{ method: string; headers: Headers }>,
  path: ProxyExcludedPath = PROXY_EXCLUDED_PATH,
): Promise<boolean> {
  try {
    const config = getConfig();
    return await isRequestAllowed(
      {
        method: request.method,
        pathname: PROXY_EXCLUDED_PATHS.includes(path) ? path : PROXY_EXCLUDED_PATH,
        headers: request.headers,
      },
      {
        required: config.access.required,
        verify: verifierFor(config.access),
        healthToken: config.healthToken,
        publicSaas: config.access.publicSaas,
      },
    );
  } catch {
    return false;
  }
}

export function forbiddenResponse(): Response {
  return Response.json(
    { error: { code: "forbidden", message: "Acces interzis." } },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

function withHeaders(response: Response): Response {
  const csp = buildCsp(createNonce(), { development: process.env.NODE_ENV === "development" });
  // Răspunsurile `Response.json` au antete mutabile; un corp în flux se re-împachetează.
  try {
    applySecurityHeaders(response.headers, csp);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    applySecurityHeaders(headers, csp);
    return new Response(response.body, { status: response.status, headers });
  }
}

/**
 * Pentru o rută exclusă din proxy: verificarea Access ÎNAINTE de orice (sesiune, corp), apoi
 * handlerul; antetele de securitate pe ambele ramuri, ca în proxy.
 */
export async function guardAccess(
  request: Request,
  run: () => Promise<Response>,
  path: ProxyExcludedPath = PROXY_EXCLUDED_PATH,
): Promise<Response> {
  if (!(await accessAllowed(request, path))) return withHeaders(forbiddenResponse());
  return withHeaders(await run());
}
