import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ro } from "@/messages/ro";
import { notificationToJson } from "@/modules/notifications/notifications.schema";
import { listNotifications } from "@/modules/notifications/notifications.service";

import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { PageHeader } from "../page-header";

import { NotificationsList } from "./notifications-list";

export const metadata: Metadata = { title: ro.notifications.title };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Notificările (modernizare 2026, pasul J; ADR 0048): lista (toate sau doar necitite), marcare
 * citită, ștergere, legătura spre preferințe. Citiri pe server, prin serviciu (RLS: doar ale tale).
 */
export default async function NotificationsPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const page = await requireLedgerPage("/notifications");
  const t = ro.notifications;
  const { unread: rawUnread } = await searchParams;
  const unreadOnly = rawUnread === "1";
  const header = (
    <PageHeader
      eyebrow={t.eyebrow}
      title={t.title}
      usageStats={page.usageStats}
      actions={
        <>
          <Link
            href={unreadOnly ? "/notifications" : "/notifications?unread=1"}
            className={buttonClasses("outline")}
          >
            {unreadOnly ? t.all : t.unreadOnly}
          </Link>
          <Link href="/settings/notifications" className={buttonClasses("outline")}>
            {t.settingsLink}
          </Link>
        </>
      }
    />
  );
  if (!page.householdId) {
    return (
      <>
        {header}
        <Card>
          <p className="text-muted-foreground">{t.noHousehold}</p>
        </Card>
      </>
    );
  }
  const householdId = page.householdId;
  const data = await load(() =>
    listNotifications({ db: page.session.runtime.db }, page.actor, householdId, {
      unread: unreadOnly,
    }),
  );
  if (!data.ok) {
    return (
      <>
        {header}
        <Alert>{ro.ledger.loadError}</Alert>
      </>
    );
  }
  const items = data.value.data.map(notificationToJson);
  return (
    <>
      {header}
      <p className="mb-4 text-muted-foreground">{t.intro}</p>
      <Card>
        {items.length === 0 ? (
          <p className="text-muted-foreground" data-testid="notifications-empty">
            {t.empty}
          </p>
        ) : (
          <NotificationsList items={items} unread={data.value.unread} />
        )}
      </Card>
    </>
  );
}
