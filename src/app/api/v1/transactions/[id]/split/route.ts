import {
  deleteSplitHandler,
  getSplitHandler,
  putSplitHandler,
} from "@/app/api/v1/_lib/family-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Împărțirea unei cheltuieli. */
export async function GET(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return getSplitHandler(request, getAuthRuntime(), id);
}

/** Setează sau înlocuiește împărțirea (doar plătitorul). */
export async function PUT(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return putSplitHandler(request, getAuthRuntime(), id);
}

/** Elimină împărțirea (doar plătitorul). */
export async function DELETE(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return deleteSplitHandler(request, getAuthRuntime(), id);
}
