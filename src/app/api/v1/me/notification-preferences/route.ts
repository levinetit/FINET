import {
  getNotificationPreferencesHandler,
  putNotificationPreferencesHandler,
} from "@/app/api/v1/_lib/notifications-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Preferințele de notificare ale utilizatorului curent (ADR 0048). */
export const GET = (request: Request) =>
  getNotificationPreferencesHandler(request, getAuthRuntime());

/** Schimbă preferințele: `inApp`, `email`, `kinds`. */
export const PUT = (request: Request) =>
  putNotificationPreferencesHandler(request, getAuthRuntime());
