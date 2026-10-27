import { z } from "zod";

/** Parametrul `{id}` din `/api/v1/me/sessions/{id}`. */
export const sessionIdSchema = z.uuid();

/** O sesiune în răspunsul API (fără token; IP-ul doar trunchiat). */
export const sessionViewSchema = z.object({
  id: z.uuid(),
  device: z.string(),
  platform: z.enum(["android", "web"]),
  ipAddress: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastActiveAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  current: z.boolean(),
});

export type SessionView = z.infer<typeof sessionViewSchema>;
