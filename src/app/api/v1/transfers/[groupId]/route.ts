import {
  deleteTransferHandler,
  getTransferHandler,
  patchTransferHandler,
} from "@/app/api/v1/_lib/ledger-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ groupId: string }> };

/** Un transfer (după `transfer_group_id`). */
export async function GET(request: Request, context: Ctx): Promise<Response> {
  const { groupId } = await context.params;
  return getTransferHandler(request, getAuthRuntime(), groupId);
}

/** Modifică un transfer. */
export async function PATCH(request: Request, context: Ctx): Promise<Response> {
  const { groupId } = await context.params;
  return patchTransferHandler(request, getAuthRuntime(), groupId);
}

/** Șterge ambele rânduri ale transferului (204). */
export async function DELETE(request: Request, context: Ctx): Promise<Response> {
  const { groupId } = await context.params;
  return deleteTransferHandler(request, getAuthRuntime(), groupId);
}
