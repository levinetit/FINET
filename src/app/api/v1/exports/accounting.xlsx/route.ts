import { exportAccountingXlsxHandler } from "@/app/api/v1/_lib/planning-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Exportul pentru contabil (Excel) (F10-C). */
export const GET = (request: Request) => exportAccountingXlsxHandler(request, getAuthRuntime());
