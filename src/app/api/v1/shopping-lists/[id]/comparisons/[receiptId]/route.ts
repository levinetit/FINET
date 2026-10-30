import { getShoppingComparisonHandler } from "@/app/api/v1/_lib/shopping-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; receiptId: string }> };

/** Comparația persistată a listei cu bonul (fără scrieri). */
export async function GET(request: Request, context: Ctx): Promise<Response> {
  const { id, receiptId } = await context.params;
  return getShoppingComparisonHandler(request, getAuthRuntime(), id, receiptId);
}
