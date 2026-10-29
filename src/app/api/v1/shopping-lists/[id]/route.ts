import {
  deleteShoppingListHandler,
  getShoppingListHandler,
  patchShoppingListHandler,
} from "@/app/api/v1/_lib/shopping-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** O listă cu articolele ei. */
export async function GET(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return getShoppingListHandler(request, getAuthRuntime(), id);
}

/** Redenumește, arhivează/reactivează sau face comună o listă personală (`shared: true`). */
export async function PATCH(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return patchShoppingListHandler(request, getAuthRuntime(), id);
}

/** Șterge definitiv lista cu articolele ei. */
export async function DELETE(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return deleteShoppingListHandler(request, getAuthRuntime(), id);
}
