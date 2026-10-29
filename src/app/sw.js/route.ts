import { serviceWorkerVersion } from "@/pwa/build-id";
import { buildServiceWorker } from "@/pwa/sw-source";

export const dynamic = "force-dynamic";

/**
 * `/sw.js` (Faza 9, ADR 0020): service worker-ul, cu domeniul `/`. Trece prin `src/proxy.ts`
 * (Access + antetele de securitate, inclusiv CSP-ul, care pentru un worker se aplică scriptului
 * însuși: `default-src 'self'`, deci doar cereri către aceeași origine). `no-cache`: browserul
 * verifică la fiecare înregistrare/actualizare dacă s-a schimbat (împreună cu
 * `updateViaCache: "none"` la înregistrare).
 */
export function GET(): Response {
  const body = buildServiceWorker({
    version: serviceWorkerVersion(),
    cacheNextStatic: process.env.NODE_ENV === "production",
  });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
      "Service-Worker-Allowed": "/",
    },
  });
}
