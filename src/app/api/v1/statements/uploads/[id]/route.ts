import { cancelUploadHandler, getUploadHandler } from "@/app/api/v1/_lib/statements-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Starea unei încărcări PDF (pentru interogarea periodică din interfață). */
export async function GET(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return getUploadHandler(request, getAuthRuntime(), id);
}

/** Renunță la încărcare: fișierul se șterge imediat. */
export async function DELETE(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return cancelUploadHandler(request, getAuthRuntime(), id);
}
