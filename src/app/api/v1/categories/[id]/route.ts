import {
  deleteCategoryHandler,
  getCategoryHandler,
  patchCategoryHandler,
} from "@/app/api/v1/_lib/ledger-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** O categorie. */
export async function GET(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return getCategoryHandler(request, getAuthRuntime(), id);
}

/** Modifică o categorie. */
export async function PATCH(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return patchCategoryHandler(request, getAuthRuntime(), id);
}

/** Șterge o categorie (`?reassignToId=` dacă e folosită). */
export async function DELETE(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return deleteCategoryHandler(request, getAuthRuntime(), id);
}
