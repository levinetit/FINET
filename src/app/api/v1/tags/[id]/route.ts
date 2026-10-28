import {
  deleteTagHandler,
  getTagHandler,
  patchTagHandler,
} from "@/app/api/v1/_lib/planning-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** O etichetă. */
export async function GET(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return getTagHandler(request, getAuthRuntime(), id);
}

/** Modifică o etichetă (cele de sistem: doar `hidden`). */
export async function PATCH(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return patchTagHandler(request, getAuthRuntime(), id);
}

/** Șterge o etichetă proprie (și legăturile ei cu tranzacțiile). */
export async function DELETE(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return deleteTagHandler(request, getAuthRuntime(), id);
}
