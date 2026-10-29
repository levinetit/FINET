import { reprocessReceiptHandler } from "@/app/api/v1/_lib/receipts-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Pune documentele bonului din nou în coadă (consumă limita zilnică). */
export async function POST(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return reprocessReceiptHandler(request, getAuthRuntime(), id);
}
