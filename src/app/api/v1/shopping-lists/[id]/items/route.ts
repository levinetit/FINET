import { addShoppingItemHandler } from "@/app/api/v1/_lib/shopping-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Adaugă un articol la sfârșitul listei (`Idempotency-Key` opțional). */
export async function POST(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return addShoppingItemHandler(request, getAuthRuntime(), id);
}
