import { deleteDocumentHandler, getDocumentHandler } from "@/app/api/v1/_lib/documents-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Starea unui document (erori cu cod stabil). */
export async function GET(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return getDocumentHandler(request, getAuthRuntime(), id);
}

/** Șterge documentul și fișierul (bonul extras dispare; tranzacția rămâne). */
export async function DELETE(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return deleteDocumentHandler(request, getAuthRuntime(), id);
}
