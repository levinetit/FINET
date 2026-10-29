import { listUploadsHandler, uploadStatementHandler } from "@/app/api/v1/_lib/statements-handlers";
import { guardAccess } from "@/lib/access-guard";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

// Calea EXACTĂ e exclusă din `src/proxy.ts` (extrase până la 20 MB; cu proxy, Next 16 ar copia
// corpul în memorie și l-ar trunchia la 10 MB). `guardAccess` refăce aceeași verificare Cloudflare
// Access și aceleași antete de securitate, ÎNAINTE de sesiune și de citirea corpului, pe fiecare
// metodă, pe calea fixă a rutei.
const PATH = "/api/v1/statements/uploads" as const;

/** Încărcările PDF recente (starea citirii de către worker). */
export const GET = (request: Request) =>
  guardAccess(request, () => listUploadsHandler(request, getAuthRuntime()), PATH);

/** Încarcă un extras (PDF, CSV, XLSX sau ZIP) pe un cont (`multipart/form-data`). */
export const POST = (request: Request) =>
  guardAccess(request, () => uploadStatementHandler(request, getAuthRuntime()), PATH);

/** `OPTIONS`: tot prin `guardAccess` (nicio metodă a căii excluse nu răspunde fără Access). */
export const OPTIONS = (request: Request) =>
  guardAccess(
    request,
    async () => new Response(null, { status: 204, headers: { Allow: "GET, POST" } }),
    PATH,
  );
