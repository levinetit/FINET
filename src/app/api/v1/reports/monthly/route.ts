import { monthlyReportHandler } from "@/app/api/v1/_lib/planning-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Raportul lunar (structura de date). */
export const GET = (request: Request) => monthlyReportHandler(request, getAuthRuntime());
