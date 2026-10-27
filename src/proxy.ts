import { NextResponse, type NextRequest } from "next/server";

import { createAccessVerifier, isRequestAllowed, type AccessVerifier } from "@/lib/access";
import { getConfig, type AccessConfig } from "@/lib/config";
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

let verifier: { key: string; verify: AccessVerifier } | null = null;

function verifierFor(access: AccessConfig): AccessVerifier | null {
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

// Rulează pe toate căile, mai puțin asset-urile statice Next (`/_next/static/`). Aceeași regulă e
// verificată și în `isStaticAssetPath`, ca o modificare a matcher-ului să nu deschidă nimic.
// Valoarea trebuie să fie literală (Next o analizează static la build).
export const config = {
  matcher: ["/((?!_next/static/).*)"],
};
