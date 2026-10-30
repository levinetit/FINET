import {
  adminAnnouncementsHandler,
  adminCreateAnnouncementHandler,
} from "@/app/api/v1/_lib/admin-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Faza 11-B (ADR 0028), doar `saas`. */
export const GET = (request: Request) => adminAnnouncementsHandler(request, getAuthRuntime());
export const POST = (request: Request) => adminCreateAnnouncementHandler(request, getAuthRuntime());
