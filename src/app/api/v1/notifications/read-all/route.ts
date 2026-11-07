import { readAllNotificationsHandler } from "@/app/api/v1/_lib/notifications-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Marchează toate notificările citite. */
export const POST = (request: Request) => readAllNotificationsHandler(request, getAuthRuntime());
