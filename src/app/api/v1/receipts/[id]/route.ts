import {
  deleteReceiptHandler,
  getReceiptHandler,
  patchReceiptHandler,
} from "@/app/api/v1/_lib/receipts-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Bonul cu liniile, problemele și furnizorul AI folosit. */
export async function GET(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return getReceiptHandler(request, getAuthRuntime(), id);
}

/** Corectează câmpurile și liniile (până la confirmare). */
export async function PATCH(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return patchReceiptHandler(request, getAuthRuntime(), id);
}

/** Șterge bonul și documentele lui; tranzacția creată rămâne. */
export async function DELETE(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return deleteReceiptHandler(request, getAuthRuntime(), id);
}
