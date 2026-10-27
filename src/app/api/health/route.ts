// STUB T1 — temporar, înlocuit în T3 de endpointul real `/api/health`
// (starea bazei de date, a storage-ului, a cozii și a furnizorului AI; master prompt 6.4).
// Există doar ca HEALTHCHECK-ul din Dockerfile să aibă ce verifica.

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
