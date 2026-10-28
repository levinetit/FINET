import {
  deleteRecurringHandler,
  getRecurringHandler,
  patchRecurringHandler,
} from "@/app/api/v1/_lib/recurring-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** O regulă recurentă. */
export async function GET(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return getRecurringHandler(request, getAuthRuntime(), id);
}

/** Modifică o regulă (suma, contul, categoria, calendarul, sfârșitul). */
export async function PATCH(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return patchRecurringHandler(request, getAuthRuntime(), id);
}

/** Șterge definitiv o regulă; tranzacțiile generate rămân. */
export async function DELETE(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return deleteRecurringHandler(request, getAuthRuntime(), id);
}
