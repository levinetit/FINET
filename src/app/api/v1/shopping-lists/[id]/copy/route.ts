import { copyShoppingListHandler } from "@/app/api/v1/_lib/shopping-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Copiază lista (articolele nebifate, fără potriviri); `Idempotency-Key` opțional. */
export async function POST(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return copyShoppingListHandler(request, getAuthRuntime(), id);
}
