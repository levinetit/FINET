import {
  deleteGoalHandler,
  getGoalHandler,
  patchGoalHandler,
} from "@/app/api/v1/_lib/planning-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Un obiectiv, cu progresul. */
export async function GET(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return getGoalHandler(request, getAuthRuntime(), id);
}

/** Modifică un obiectiv (`status`: `abandoned` sau `active`). */
export async function PATCH(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return patchGoalHandler(request, getAuthRuntime(), id);
}

/** Șterge definitiv un obiectiv. */
export async function DELETE(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return deleteGoalHandler(request, getAuthRuntime(), id);
}
