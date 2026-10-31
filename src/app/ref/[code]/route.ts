import { type NextRequest, NextResponse } from "next/server";

import { getConfig } from "@/lib/config";
import {
  REF_COOKIE,
  REF_COOKIE_MAX_AGE_SECONDS,
  parseRefCode,
} from "@/modules/referrals/referrals.service";

export const dynamic = "force-dynamic";

/**
 * Linkul de recomandare `/ref/FIN-XXXXXX` (Faza 12-C, ADR 0037). Doar `saas`: în `personal`
 * (și la o configurație ilizibilă) răspunde 404, ca și cum n-ar exista. Reține codul într-un
 * cookie HttpOnly și trimite spre `/register`. Răspunsul e IDENTIC pentru un cod valid ca formă
 * și pentru unul invalid (nu spune dacă un cod există); existența și regulile le verifică baza de
 * date abia la confirmarea contului.
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ code: string }> }) {
  let config: ReturnType<typeof getConfig>;
  try {
    config = getConfig();
  } catch {
    return new NextResponse(null, { status: 404 });
  }
  if (config.appMode !== "saas") return new NextResponse(null, { status: 404 });

  const { code } = await context.params;
  let parsed: string | null = null;
  try {
    parsed = parseRefCode(decodeURIComponent(code));
  } catch {
    // Percent-encoding stricat: tratat ca un cod invalid.
  }
  const origin = new URL(config.appUrl ?? "http://localhost:3000");
  const response = NextResponse.redirect(new URL("/register", origin.origin), 303);
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Cache-Control", "no-store");
  if (parsed) {
    response.cookies.set(REF_COOKIE, parsed, {
      httpOnly: true,
      sameSite: "lax",
      secure: origin.protocol === "https:",
      path: "/",
      maxAge: REF_COOKIE_MAX_AGE_SECONDS,
    });
  }
  return response;
}
