import { reorderShoppingItemsHandler } from "@/app/api/v1/_lib/shopping-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Ordinea articolelor: o permutare exactă a celor din listă (altfel 409 `order_mismatch`). */
export async function PUT(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return reorderShoppingItemsHandler(request, getAuthRuntime(), id);
}
