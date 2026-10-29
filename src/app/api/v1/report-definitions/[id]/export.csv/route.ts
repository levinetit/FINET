import { exportReportHandler } from "@/app/api/v1/_lib/prices-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Exportul CSV al liniilor potrivite de raport. */
export const GET = async (request: Request, { params }: Context) =>
  exportReportHandler(request, getAuthRuntime(), (await params).id);
