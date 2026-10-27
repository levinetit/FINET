import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

/**
 * Verificarea Cloudflare Access (master prompt 3.1): fiecare cerere trebuie să poarte un JWT
 * `Cf-Access-Jwt-Assertion` semnat de organizația Zero Trust, pentru aplicația FINET.
 * Cererile care ocolesc tunelul nu au un astfel de JWT și sunt respinse.
 *
 * FAIL CLOSED: orice problemă (antet lipsă, semnătură, `aud`/`iss` greșite, token expirat,
 * cheile publice indisponibile, configurație invalidă) înseamnă „refuzat”, niciodată „permis”.
 */

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
export const HEALTH_TOKEN_HEADER = "x-finet-health-token";

/** Căile publice ale liveness-ului (healthcheck Docker) și ale stării detaliate. */
export const HEALTH_PATH = "/api/health";
export const LIVENESS_PATH = "/api/health/live";

/** Toleranța de ceas la verificarea `exp`/`nbf`/`iat`, în secunde. */
export const CLOCK_TOLERANCE_SECONDS = 10;

const MAX_TOKEN_LENGTH = 8192;

/** Verifică un token; aruncă dacă nu e valid. */
export type AccessVerifier = (token: string) => Promise<JWTPayload>;

export type AccessVerifierOptions = Readonly<{
  teamDomain: string;
  aud: string;
  /** Sursa cheilor publice; implicit JWKS-ul organizației (`/cdn-cgi/access/certs`). */
  keys?: JWTVerifyGetKey;
}>;

// Un singur set de chei la distanță per domeniu: jose îl ține în cache și îl reîmprospătează
// când apare un `kid` necunoscut (cel mult o dată la `cooldownDuration`).
const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function remoteKeys(teamDomain: string): JWTVerifyGetKey {
  let keys = remoteKeySets.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`), {
      timeoutDuration: 3000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
    remoteKeySets.set(teamDomain, keys);
  }
  return keys;
}

export function createAccessVerifier(options: AccessVerifierOptions): AccessVerifier {
  const issuer = `https://${options.teamDomain}`;
  const keys = options.keys ?? remoteKeys(options.teamDomain);
  return async (token: string) => {
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      throw new Error("token invalid");
    }
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience: options.aud,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["exp"],
    });
    return payload;
  };
}

/**
 * Asset-urile statice Next, excluse de la verificare (și din `matcher`-ul din `src/proxy.ts`).
 * Conțin doar cod și stiluri compilate, fără date; secretele nu ajung acolo (vezi
 * `scripts/scan-client-secrets.mjs`).
 *
 * `/favicon.ico` NU e exclus (decizie): nu există un favicon, iar cererea ar fi servită de
 * pagina 404 randată prin layout-ul aplicației, fără verificare. Access trimite oricum JWT-ul
 * și pentru favicon după login; excluderea ar fi fost doar o optimizare.
 */
export function isStaticAssetPath(pathname: string): boolean {
  return pathname.startsWith("/_next/static/");
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
// Antete adăugate de Cloudflare / cloudflared / Traefik; prezența lor arată o cerere din afară.
const EDGE_HEADERS = ["cf-connecting-ip", "cf-ray", "cf-ipcountry", "x-real-ip", ACCESS_JWT_HEADER];

function hostnameOf(host: string | null): string | null {
  if (!host) return null;
  const match = /^(\[[0-9a-f:.]+\]|[^:]+)(?::\d{1,5})?$/i.exec(host.trim());
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * Cerere de liveness venită din interiorul containerului (healthcheck-ul Docker către
 * `127.0.0.1`), nu prin Traefik sau tunel: `Host` e o adresă loopback și lipsesc antetele
 * puse de proxy-uri. `X-Forwarded-*`, dacă există, trebuie să indice tot loopback (serverul
 * Next le completează singur cu adresa conexiunii). Liveness-ul nu expune nimic în afară de
 * „procesul răspunde”.
 */
export function isLocalProbe(headers: Headers): boolean {
  const host = hostnameOf(headers.get("host"));
  if (!host || !LOOPBACK_HOSTS.has(host)) return false;
  if (EDGE_HEADERS.some((h) => headers.has(h))) return false;
  const xff = headers.get("x-forwarded-for");
  if (xff !== null && !LOOPBACK_ADDRESSES.has(xff.trim())) return false;
  const xfh = headers.get("x-forwarded-host");
  if (xfh !== null) {
    const fh = hostnameOf(xfh);
    if (!fh || !LOOPBACK_HOSTS.has(fh)) return false;
  }
  return true;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Compară tokenul primit cu cel configurat în timp constant (pe rezumate, deci și lungimea). */
export function healthTokenMatches(received: string | null, expected: string | null): boolean {
  if (!expected || !received) return false;
  return timingSafeEqual(sha256(received), sha256(expected));
}

export type AccessPolicy = Readonly<{
  required: boolean;
  verify: AccessVerifier | null;
  healthToken: string | null;
}>;

/**
 * Decide dacă cererea trece. Excepții, în ordine:
 * 1. asset-urile statice Next (`isStaticAssetPath`);
 * 2. `GET /api/health/live` venit de pe loopback (`isLocalProbe`), DOAR cu metoda `GET` (exact
 *    calea, fără `/` final sau variante codificate); `HEAD`, `POST` etc. cer Access;
 * 3. `/api/health` cu `X-Finet-Health-Token` corect (doar dacă `HEALTH_TOKEN` e configurat).
 * Altfel, cu `required`, e nevoie de un JWT Access valid.
 */
export async function isRequestAllowed(
  // `method` e obligatoriu: un apelant care nu-l transmite nu poate primi excepția de liveness.
  request: Readonly<{ method: string; pathname: string; headers: Headers }>,
  policy: AccessPolicy,
): Promise<boolean> {
  const { method, pathname, headers } = request;
  if (isStaticAssetPath(pathname)) return true;
  if (method === "GET" && pathname === LIVENESS_PATH && isLocalProbe(headers)) return true;
  if (
    pathname === HEALTH_PATH &&
    healthTokenMatches(headers.get(HEALTH_TOKEN_HEADER), policy.healthToken)
  ) {
    return true;
  }
  if (!policy.required) return true;
  if (!policy.verify) return false;
  const token = headers.get(ACCESS_JWT_HEADER);
  if (!token) return false;
  try {
    await policy.verify(token);
    return true;
  } catch {
    return false;
  }
}
