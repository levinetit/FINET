import { dataExportHandler } from "@/app/api/v1/_lib/gdpr-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Exportul GDPR complet al contului: arhivă ZIP în flux (JSON, CSV, fișierele bonurilor). */
export const GET = (request: Request) => dataExportHandler(request, getAuthRuntime());
