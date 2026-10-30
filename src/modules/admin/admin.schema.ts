import { z } from "zod";

import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_LEVELS,
  ANNOUNCEMENT_TITLE_MAX,
  APP_ERROR_KINDS,
  FEEDBACK_KINDS,
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_STATUSES,
} from "@/db/schema/admin";

/**
 * Schemele panoului de administrare, ale feedback-ului și ale anunțurilor (Faza 11-B, ADR 0028),
 * fără dependențe de server: le folosesc serviciile, API-ul și generatorul OpenAPI. Toate sunt
 * STRICTE (câmpuri necunoscute → 400). Nicio schemă nu primește `userId`/`householdId` din cerere.
 */

const route = z
  .string()
  .max(200)
  .regex(/^\/[A-Za-z0-9/_[\]-]*$/);

export const feedbackCreateSchema = z.strictObject({
  kind: z.enum(FEEDBACK_KINDS),
  message: z.string().trim().min(3).max(FEEDBACK_MESSAGE_MAX),
  page: route.optional(),
  appVersion: z.string().trim().min(1).max(40).optional(),
});
export type FeedbackCreate = z.infer<typeof feedbackCreateSchema>;

export const feedbackStatusSchema = z.strictObject({ status: z.enum(FEEDBACK_STATUSES) });

export const announcementCreateSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(ANNOUNCEMENT_TITLE_MAX),
    body: z.string().trim().min(1).max(ANNOUNCEMENT_BODY_MAX),
    level: z.enum(ANNOUNCEMENT_LEVELS).default("info"),
    startsAt: z.iso.datetime().optional(),
    endsAt: z.iso.datetime().nullable().optional(),
  })
  .refine((v) => !v.endsAt || !v.startsAt || v.endsAt > v.startsAt, {
    message: "Sfârșitul trebuie să fie după început.",
  });
export type AnnouncementCreate = z.infer<typeof announcementCreateSchema>;

export const announcementUpdateSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(ANNOUNCEMENT_TITLE_MAX).optional(),
    body: z.string().trim().min(1).max(ANNOUNCEMENT_BODY_MAX).optional(),
    level: z.enum(ANNOUNCEMENT_LEVELS).optional(),
    endsAt: z.iso.datetime().nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Nimic de modificat." });
export type AnnouncementUpdate = z.infer<typeof announcementUpdateSchema>;

export const userStatusSchema = z.strictObject({ status: z.enum(["active", "disabled"]) });

export const adminPageSchema = z
  .strictObject({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
    status: z.enum(FEEDBACK_STATUSES).optional(),
  })
  .optional();

export const errorReportSchema = z.strictObject({
  kind: z.enum(APP_ERROR_KINDS),
  route,
  code: z.string().regex(/^[A-Za-z0-9_.:-]{1,60}$/),
  digest: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,40}$/)
    .optional(),
  appVersion: z.string().trim().min(1).max(40).optional(),
});
export type ErrorReport = z.infer<typeof errorReportSchema>;
