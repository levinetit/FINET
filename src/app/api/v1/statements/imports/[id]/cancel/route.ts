import { cancelImportHandler } from "@/app/api/v1/_lib/statements-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Anulează un import confirmat (șterge doar tranzacțiile create de el). */
export async function POST(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return cancelImportHandler(request, getAuthRuntime(), id);
}
