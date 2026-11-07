import { listNotificationsHandler } from "@/app/api/v1/_lib/notifications-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Notificările utilizatorului în gospodăria curentă (`?unread=&limit=`), ADR 0048. */
export const GET = (request: Request) => listNotificationsHandler(request, getAuthRuntime());
