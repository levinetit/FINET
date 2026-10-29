import { NextResponse, type NextRequest } from "next/server";

import { isRequestAllowed } from "@/lib/access";
import { verifierFor } from "@/lib/access-guard";
import { getConfig } from "@/lib/config";
import { NONCE_HEADER, applySecurityHeaders, buildCsp, createNonce } from "@/lib/security-headers";

/**
 * Proxy Next.js 16 (fostul `middleware.ts`; rulează în runtime-ul Node): protecția Cloudflare
 * Access pentru toate cererile, cu excepțiile din `src/lib/access.ts`. FAIL CLOSED: orice
 * eroare, inclusiv configurația invalidă sau cheile Access indisponibile, dă 403 fără detalii.
 *
 * Antetele de securitate (6.3, `src/lib/security-headers.ts`) se adaugă DUPĂ decizia Access, pe
 * ambele ramuri (403 și cererea permisă): CSP cu un nonce nou per cerere, pus și în antetele
 * cererii, ca Next.js să-l atașeze scripturilor la randare. Verificarea Access rămâne prima și
 * nu depinde de antete.
 */

function forbidden(): NextResponse {
  return NextResponse.json(
    { error: { code: "forbidden", message: "Acces interzis." } },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  let allowed = false;
  try {
    const config = getConfig();
    allowed = await isRequestAllowed(
      { method: request.method, pathname: request.nextUrl.pathname, headers: request.headers },
      {
        required: config.access.required,
        verify: verifierFor(config.access),
        healthToken: config.healthToken,
      },
    );
  } catch {
    allowed = false;
  }

  const nonce = createNonce();
  const csp = buildCsp(nonce, { development: process.env.NODE_ENV === "development" });
  if (!allowed) {
    const response = forbidden();
    applySecurityHeaders(response.headers, csp);
    return response;
  }
  // Valorile venite de la client pentru aceste antete interne se înlocuiesc, nu se păstrează.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  applySecurityHeaders(response.headers, csp);
  return response;
}

// Rulează pe toate căile, mai puțin:
// - asset-urile statice Next (`/_next/static/`); aceeași regulă e verificată și în
//   `isStaticAssetPath`, ca o modificare a matcher-ului să nu deschidă nimic;
// - EXACT `/api/v1/documents` (Faza 6, ADR 0015): cu proxy, Next 16 copiază corpul în memorie și îl
//   trunchiază fără eroare la `proxyClientMaxBodySize` (10 MB), deci încărcarea n-ar mai fi un flux.
//   Ruta refăce aceeași verificare Access și aceleași antete (`guardAccess`, `src/lib/access-guard.ts`)
//   înainte de sesiune și de corp, pe toate metodele ei. Sub-căile (`/api/v1/documents/<id>`,
//   `/file`) trec în continuare prin proxy (testat în `src/proxy.test.ts`).
// Valoarea trebuie să fie literală (Next o analizează static la build).
export const config = {
  matcher: ["/((?!_next/static/|api/v1/documents$).*)"],
};
