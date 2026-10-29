import { confirmReceiptHandler } from "@/app/api/v1/_lib/receipts-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Confirmă bonul: creează tranzacția (`Idempotency-Key` opțional). */
export async function POST(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return confirmReceiptHandler(request, getAuthRuntime(), id);
}
