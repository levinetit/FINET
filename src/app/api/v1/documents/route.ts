import { listDocumentsHandler, uploadDocumentsHandler } from "@/app/api/v1/_lib/documents-handlers";
import { guardAccess } from "@/lib/access-guard";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

// Calea EXACTĂ e exclusă din `src/proxy.ts` (încărcarea rămâne flux; Next 16 ar copia corpul în
// memorie și l-ar trunchia la 10 MB). `guardAccess` refăce aceeași verificare Cloudflare Access și
// aceleași antete de securitate, ÎNAINTE de sesiune și de citirea corpului, pe fiecare metodă.

/** Documentele gospodăriei (cele mai noi întâi), cu starea și bonul extras. */
export const GET = (request: Request) =>
  guardAccess(request, () => listDocumentsHandler(request, getAuthRuntime()));

/** Încarcă 1–4 fișiere (`multipart/form-data`), opțional ca bon lung (`longReceipt=true`). */
export const POST = (request: Request) =>
  guardAccess(request, () => uploadDocumentsHandler(request, getAuthRuntime()));

/**
 * `OPTIONS` (preflight sau sondă): tot prin `guardAccess`, ca nicio metodă a căii excluse din
 * proxy să nu răspundă fără verificarea Access. Fără CORS (aceeași origine). Celelalte metode
 * primesc 405 de la Next, fără corp, înaintea oricărui handler.
 */
export const OPTIONS = (request: Request) =>
  guardAccess(
    request,
    async () => new Response(null, { status: 204, headers: { Allow: "GET, POST" } }),
  );
