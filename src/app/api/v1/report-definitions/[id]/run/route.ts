import { runReportHandler } from "@/app/api/v1/_lib/prices-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Rulează raportul pe o perioadă: total, bucăți, preț mediu, proiecție anuală, istoric. */
export const GET = async (request: Request, { params }: Context) =>
  runReportHandler(request, getAuthRuntime(), (await params).id);
