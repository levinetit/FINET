import Link from "next/link";

import { ro } from "@/messages/ro";

import { BellIcon } from "./icons";

/** Bannerul discret cu notificările necitite (ADR 0048), deasupra conținutului. */
export function NotificationsBadge({ unread }: Readonly<{ unread: number }>) {
  return (
    <div className="mb-3">
      <Link
        href="/notifications?unread=1"
        className="inline-flex items-center gap-2 rounded-md bg-accent-soft px-3 py-1.5 text-sm font-medium hover:text-primary"
        data-testid="notifications-badge"
        data-unread={unread}
      >
        <BellIcon />
        {ro.notifications.bell(unread)}
      </Link>
    </div>
  );
}
