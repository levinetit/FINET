/**
 * Tipurile de notificări (ADR 0048), într-un modul FĂRĂ dependențe: e importat și de componente
 * client (formularul de preferințe), unde schema Drizzle nu are ce căuta în bundle (revizuirea
 * bugetului JS: `/settings/notifications` ajunsese la 229 KiB cu `@/db/schema` în client).
 */
export const NOTIFICATION_KINDS = [
  "payment_due",
  "budget_warning",
  "budget_exceeded",
  "unusual_spending",
  "goal_reminder",
  "subscription_renewal",
  "monthly_summary",
  "sync_failure",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
