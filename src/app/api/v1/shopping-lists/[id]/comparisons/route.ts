import { runShoppingComparisonHandler } from "@/app/api/v1/_lib/shopping-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Compară lista cu un bon confirmat: propune potrivirile (idempotent) și întoarce rezultatul. */
export async function POST(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return runShoppingComparisonHandler(request, getAuthRuntime(), id);
}
