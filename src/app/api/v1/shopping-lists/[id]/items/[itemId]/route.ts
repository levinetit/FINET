import {
  deleteShoppingItemHandler,
  patchShoppingItemHandler,
} from "@/app/api/v1/_lib/shopping-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; itemId: string }> };

/** Modifică un articol; `checked: true|false` este starea bifării (idempotentă). */
export async function PATCH(request: Request, context: Ctx): Promise<Response> {
  const { id, itemId } = await context.params;
  return patchShoppingItemHandler(request, getAuthRuntime(), id, itemId);
}

/** Șterge un articol. */
export async function DELETE(request: Request, context: Ctx): Promise<Response> {
  const { id, itemId } = await context.params;
  return deleteShoppingItemHandler(request, getAuthRuntime(), id, itemId);
}
