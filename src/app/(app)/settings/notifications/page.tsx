import type { Metadata } from "next";

import { ro } from "@/messages/ro";
import { preferencesToJson } from "@/modules/notifications/notifications.schema";
import { getPreferences } from "@/modules/notifications/notifications.service";

import { requirePageSession } from "../../../_lib/session";
import { PageHeader } from "../../page-header";

import { PreferencesForm } from "./preferences-form";

export const metadata: Metadata = { title: ro.notifications.preferences.title };

/** Setări → Notificări (ADR 0048): preferințele utilizatorului curent (RLS: doar ale lui). */
export default async function NotificationSettingsPage() {
  const session = await requirePageSession("/settings/notifications");
  const t = ro.notifications.preferences;
  const prefs = preferencesToJson(await getPreferences(session.runtime.db, session.userId));
  return (
    <>
      <PageHeader eyebrow={t.eyebrow} title={t.title} />
      <PreferencesForm initial={prefs} />
    </>
  );
}
