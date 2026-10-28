import {
  deleteBudgetHandler,
  getBudgetHandler,
  patchBudgetHandler,
} from "@/app/api/v1/_lib/planning-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Un buget. */
export async function GET(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return getBudgetHandler(request, getAuthRuntime(), id);
}

/** Modifică suma, pragul de avertizare sau arhivarea. */
export async function PATCH(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return patchBudgetHandler(request, getAuthRuntime(), id);
}

/** Șterge definitiv un buget. */
export async function DELETE(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return deleteBudgetHandler(request, getAuthRuntime(), id);
}
