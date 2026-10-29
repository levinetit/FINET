import { z } from "zod";

/**
 * Schema răspunsului `GET /api/v1/admin/stats` (6.5; F9-B, ADR 0021), fără dependențe de server
 * (OpenAPI și contractul testat). Doar numere, platforme, versiuni, zile, nume de evenimente și
 * coduri de eroare; `members` doar în modul `personal` (altfel `null`).
 */

const count = z.number().int().nonnegative();
const version = z.string().nullable();

export const usageStatsSchema = z.strictObject({
  generatedAt: z.string(),
  activeUsers: z.array(
    z.strictObject({ platform: z.string(), daily: count, weekly: count, monthly: count }),
  ),
  sessionUsers: z.strictObject({
    daily: count,
    weekly: count,
    monthly: count,
    expiredSessions: count,
  }),
  installations: z.array(
    z.strictObject({
      platform: z.string(),
      appVersion: version,
      versionCode: z.number().int().nullable(),
      count,
      belowMinimum: z.boolean(),
      outdated: z.boolean(),
    }),
  ),
  downloads: z.array(z.strictObject({ version: z.string(), source: z.string(), count })),
  logins: z.array(z.strictObject({ day: z.string(), platform: z.string(), count })),
  features: z.array(z.strictObject({ name: z.string(), count })),
  screens: z.array(z.strictObject({ screen: z.string(), count })),
  errors: z.array(z.strictObject({ errorCode: z.string(), appVersion: version, count })),
  ai: z.array(
    z.strictObject({ provider: z.string(), result: z.string(), count, avgDurationMs: count }),
  ),
  aiCost: z.array(
    z.strictObject({ month: z.string(), currency: z.string(), costMinor: z.number().int() }),
  ),
  archivedEvents: count,
  latestAndroid: z
    .strictObject({
      versionName: z.string(),
      versionCode: z.number().int(),
      minSupportedVersionCode: z.number().int(),
    })
    .nullable(),
  members: z
    .array(
      z.strictObject({
        userId: z.uuid(),
        name: z.string(),
        lastSeenAt: z.string().nullable(),
        platform: z.string().nullable(),
        appVersion: version,
        versionCode: z.number().int().nullable(),
        belowMinimum: z.boolean(),
        outdated: z.boolean(),
      }),
    )
    .nullable(),
});
