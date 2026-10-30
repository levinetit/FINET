import { exportAccountingCsvHandler } from "@/app/api/v1/_lib/planning-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Exportul pentru contabil (CSV) (F10-C). */
export const GET = (request: Request) => exportAccountingCsvHandler(request, getAuthRuntime());
