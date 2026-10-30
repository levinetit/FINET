import { z } from "zod";

import { CONSENT_KINDS } from "@/db/schema";

/**
 * Schemele statisticilor de utilizare (6.5, ADR 0005), fără dependențe de server: le folosesc
 * serviciile (`consents.ts`, `events.ts`), API-ul și generatorul OpenAPI.
 */

/** Numele din API (camelCase) ↔ tipul din bază. */
export const CONSENT_API_NAMES = {
  usageStats: "usage_stats",
  externalAi: "external_ai",
  externalAiStatements: "external_ai_statements",
  // F10-C (ADR 0026): textul întrebărilor „Întreabă FINET” către un model extern.
  externalAiAsk: "external_ai_ask",
} as const satisfies Record<string, (typeof CONSENT_KINDS)[number]>;

export const consentsPutSchema = z
  .strictObject({
    usageStats: z.boolean().optional(),
    externalAi: z.boolean().optional(),
    externalAiStatements: z.boolean().optional(),
    externalAiAsk: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nimic de modificat.",
  });

/** Numele permise (lista din `docs/FINET_ANDROID_MASTER_PROMPT.md`, 10.1). */
export const APP_EVENT_NAMES = [
  "app_open",
  "login",
  "logout",
  "session_expired",
  "screen_view",
  "receipt_scan_started",
  "receipt_uploaded",
  "receipt_confirmed",
  "statement_imported",
  "transaction_created",
  "share_import",
  "update_prompt_shown",
  "update_started",
  "error_shown",
  // Faza 3 (F3-B): doar numele, fără sume sau alte câmpuri.
  "dashboard_viewed",
  "report_viewed",
  "budget_created",
  "goal_created",
  "goal_contribution_added",
  "tag_created",
  "export_downloaded",
  // Faza 5 (F5-B): doar numele.
  "recurring_created",
  "recurring_generated",
] as const;

/** Ecranele (doar numele, pentru `screen_view` și ca context al unei erori). */
export const APP_SCREENS = [
  "login",
  "onboarding",
  "dashboard",
  "transactions",
  "transaction_detail",
  "transaction_edit",
  "accounts",
  "categories",
  "transfers",
  "scan",
  "receipts",
  "statements",
  "budgets",
  "goals",
  "recurring",
  "reports",
  "settings",
  "profile",
  "update",
] as const;

/** Codurile de eroare afișate (litere mici, ca CHECK-ul din bază). */
export const APP_ERROR_CODES = [
  "network_timeout",
  "network_unavailable",
  "access_required",
  "server_error",
  "unauthenticated",
  "forbidden",
  "not_found",
  "validation_failed",
  "conflict",
  "rate_limited",
  "update_required",
  "upload_failed",
  "unknown",
] as const;

export const MAX_EVENTS_PER_BATCH = 20;
/** Fereastra acceptată pentru `occurredAt`: cel mult 30 de zile în urmă, 5 minute în viitor. */
export const EVENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const EVENT_MAX_SKEW_MS = 5 * 60 * 1000;

export const appEventSchema = z.strictObject({
  name: z.enum(APP_EVENT_NAMES),
  screen: z.enum(APP_SCREENS).optional(),
  errorCode: z.enum(APP_ERROR_CODES).optional(),
  occurredAt: z.iso.datetime(),
});

export const appEventsBatchSchema = z.strictObject({
  events: z.array(appEventSchema).min(1).max(MAX_EVENTS_PER_BATCH),
});

/** Mesajul fix pentru un lot respins (nu repetă nimic din cerere). */
export const EVENTS_REJECTED_MESSAGE = "Evenimentele nu sunt valide.";
