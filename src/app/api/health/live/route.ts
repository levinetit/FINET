/**
 * `GET /api/health/live`: liveness pentru healthcheck-ul Docker. Întoarce doar 200 și `ok`,
 * fără nicio verificare și fără detalii. `src/proxy.ts` îl lasă fără JWT Access numai pentru
 * cereri locale (Host loopback, fără antetele Cloudflare/Traefik); prin tunel sau Traefik cere
 * Access ca orice altă cale. Nu se publică prin tunel ca rută separată.
 */

export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response("ok", {
    status: 200,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}
