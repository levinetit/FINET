import { NextResponse, type NextRequest } from "next/server";

import { createAccessVerifier, isRequestAllowed, type AccessVerifier } from "@/lib/access";
import { getConfig, type AccessConfig } from "@/lib/config";

/**
 * Proxy Next.js 16 (fostul `middleware.ts`; rulează în runtime-ul Node): protecția Cloudflare
 * Access pentru toate cererile, cu excepțiile din `src/lib/access.ts`. FAIL CLOSED: orice
 * eroare, inclusiv configurația invalidă sau cheile Access indisponibile, dă 403 fără detalii.
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
      { pathname: request.nextUrl.pathname, headers: request.headers },
      {
        required: config.access.required,
        verify: verifierFor(config.access),
        healthToken: config.healthToken,
      },
    );
  } catch {
    allowed = false;
  }
  return allowed ? NextResponse.next() : forbidden();
}

// Rulează pe toate căile, mai puțin asset-urile statice Next și favicon-ul. Aceeași listă e
// verificată și în `isStaticAssetPath`, ca o modificare a matcher-ului să nu deschidă nimic.
// Valoarea trebuie să fie literală (Next o analizează static la build).
export const config = {
  matcher: ["/((?!_next/static/|favicon\\.ico$).*)"],
};
