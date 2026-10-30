import { exportReceiptsXlsxHandler } from "@/app/api/v1/_lib/planning-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Lista bonurilor (Excel) (F10-C). */
export const GET = (request: Request) => exportReceiptsXlsxHandler(request, getAuthRuntime());
