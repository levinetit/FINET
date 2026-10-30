import { matchShoppingItemHandler } from "@/app/api/v1/_lib/shopping-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; itemId: string }> };

/** Confirmă, respinge, șterge sau corectează potrivirea unui articol cu o linie de bon. */
export async function POST(request: Request, context: Ctx): Promise<Response> {
  const { id, itemId } = await context.params;
  return matchShoppingItemHandler(request, getAuthRuntime(), id, itemId);
}
