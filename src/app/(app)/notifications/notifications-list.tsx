"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ro } from "@/messages/ro";
import type { NotificationJson } from "@/modules/notifications/notifications.schema";

import { goToLogin } from "../../_lib/api-client";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

/**
 * Lista notificărilor (ADR 0048): marcare citită (pe rând sau toate) și ștergere, prin
 * `/api/v1/notifications/*`; după fiecare acțiune pagina se reîmprospătează.
 */
export function NotificationsList({
  items,
  unread,
}: Readonly<{ items: readonly NotificationJson[]; unread: number }>) {
  const t = ro.notifications;
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [error, setError] = useState<string | null>(null);

  async function act(path: string, method: "POST" | "DELETE") {
    setError(null);
    const r = await submit(path, method);
    if (!r) return;
    if (r.status === 401) return goToLogin();
    if (!r.ok) {
      setError(t.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <Alert>{error}</Alert> : null}
      {unread > 0 ? (
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={!hydrated || pending}
            onClick={() => void act("/api/v1/notifications/read-all", "POST")}
            data-testid="notifications-read-all"
          >
            {t.markAllRead}
          </Button>
        </div>
      ) : null}
      <ul className="flex flex-col divide-y divide-border" data-testid="notifications-list">
        {items.map((n) => (
          <li
            key={n.id}
            className={cn("flex flex-col gap-1 py-3", n.readAt ? "text-muted-foreground" : "")}
            data-testid="notification"
            data-kind={n.kind}
            data-read={n.readAt ? "true" : "false"}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-xs tracking-[0.06em] uppercase">{t.kinds[n.kind]}</span>
              <span className="text-xs">
                {new Date(n.createdAt).toLocaleDateString("ro-RO")}
                {n.readAt ? ` · ${t.read}` : ""}
              </span>
            </div>
            <p className={cn("font-medium", n.readAt ? "" : "text-foreground")}>{n.title}</p>
            <p className="text-sm">{n.body}</p>
            <div className="flex flex-wrap gap-2 pt-1">
              {n.link ? (
                <Link href={n.link} className="text-sm text-primary underline">
                  {t.open}
                </Link>
              ) : null}
              {!n.readAt ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!hydrated || pending}
                  onClick={() => void act(`/api/v1/notifications/${n.id}/read`, "POST")}
                >
                  {t.markRead}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                disabled={!hydrated || pending}
                onClick={() => void act(`/api/v1/notifications/${n.id}`, "DELETE")}
              >
                {t.delete}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
