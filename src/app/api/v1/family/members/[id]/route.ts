import { deleteMemberHandler, patchMemberHandler } from "@/app/api/v1/_lib/family-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Schimbă rolul unui membru (doar owner). */
export async function PATCH(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return patchMemberHandler(request, getAuthRuntime(), id);
}

/** Scoate un membru (doar owner); avertizează la solduri nedecontate. */
export async function DELETE(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return deleteMemberHandler(request, getAuthRuntime(), id);
}
