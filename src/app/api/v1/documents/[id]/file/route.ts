import { documentFileHandler } from "@/app/api/v1/_lib/documents-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Fișierul original (flux, `attachment`, `nosniff`, `no-store`), doar pentru membri. */
export async function GET(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return documentFileHandler(request, getAuthRuntime(), id);
}
