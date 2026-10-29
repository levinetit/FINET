import { OFFLINE_HTML } from "@/pwa/offline-page";

export const dynamic = "force-dynamic";

/**
 * `/offline` (Faza 9, ADR 0020): pagina afișată de service worker când o navigare eșuează din
 * lipsă de rețea. HTML fix: nu citește sesiunea (deci nu poate seta cookie-uri și nu conține
 * date), trece prin `src/proxy.ts` ca orice cale (Access + antete). `no-cache` (nu `no-store`):
 * service worker-ul o poate păstra în cache-ul static versionat.
 */
export function GET(): Response {
  return new Response(OFFLINE_HTML, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
