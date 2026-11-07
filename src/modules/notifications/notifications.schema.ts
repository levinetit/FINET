import { z } from "zod";

import { NOTIFICATION_KINDS } from "@/db/schema";

import type { NotificationRow, PreferencesRow } from "./notifications.repo";

/** Notificările (ADR 0048): intrări Zod și forma JSON. */

export const NOTIFICATIONS_LIMIT_DEFAULT = 50;
export const NOTIFICATIONS_LIMIT_MAX = 200;

export const notificationsListSchema = z
  .strictObject({
    unread: z.boolean().optional(),
    limit: z.number().int().min(1).max(NOTIFICATIONS_LIMIT_MAX).optional(),
  })
  .optional();

export const preferencesPutSchema = z
  .strictObject({
    inApp: z.boolean().optional(),
    email: z.boolean().optional(),
    kinds: z.array(z.enum(NOTIFICATION_KINDS)).max(NOTIFICATION_KINDS.length).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Nimic de modificat." })
  .transform((v) => ({ ...v, kinds: v.kinds ? [...new Set(v.kinds)] : undefined }));

export type PreferencesPut = z.infer<typeof preferencesPutSchema>;

export function notificationToJson(n: NotificationRow) {
  return {
    id: n.id,
    householdId: n.householdId,
    kind: n.kind,
    title: n.title,
    body: n.body,
    link: n.link,
    createdAt: n.createdAt.toISOString(),
    readAt: n.readAt ? n.readAt.toISOString() : null,
  };
}

export type NotificationJson = ReturnType<typeof notificationToJson>;

export function preferencesToJson(p: PreferencesRow | null) {
  return {
    inApp: p?.inApp ?? true,
    email: p?.email ?? false,
    kinds: p?.kinds ?? [...NOTIFICATION_KINDS],
  };
}

export type PreferencesJson = ReturnType<typeof preferencesToJson>;
