import { previewReportHandler } from "@/app/api/v1/_lib/prices-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Previzualizare: rulează regulile din corp pe perioada aleasă, fără să salveze nimic. */
export const POST = (request: Request) => previewReportHandler(request, getAuthRuntime());
