"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NOTIFICATION_KINDS } from "@/db/schema";
import { ro } from "@/messages/ro";
import type { PreferencesJson } from "@/modules/notifications/notifications.schema";

import { goToLogin } from "../../../_lib/api-client";
import { useHydrated } from "../../../_lib/use-hydrated";
import { useSubmit } from "../../../_lib/use-submit";

/** Formularul preferințelor de notificare (ADR 0048): `PUT /api/v1/me/notification-preferences`. */
export function PreferencesForm({ initial }: Readonly<{ initial: PreferencesJson }>) {
  const t = ro.notifications.preferences;
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const kinds = NOTIFICATION_KINDS.filter((k) => data.get(`kind-${k}`) === "on");
    setError(null);
    setInfo(null);
    const r = await submit("/api/v1/me/notification-preferences", "PUT", {
      inApp: data.get("inApp") === "on",
      email: data.get("email") === "on",
      kinds,
    });
    if (!r) return;
    if (r.status === 401) return goToLogin();
    if (!r.ok) {
      setError(t.error);
      return;
    }
    setInfo(t.saved);
    router.refresh();
  }

  return (
    <Card aria-labelledby="prefs-title" data-testid="notification-preferences">
      <CardHeader>
        <CardTitle id="prefs-title">{t.title}</CardTitle>
        <CardDescription>{t.intro}</CardDescription>
      </CardHeader>
      {error ? <Alert className="mb-3">{error}</Alert> : null}
      {info ? (
        <Alert tone="ok" className="mb-3">
          {info}
        </Alert>
      ) : null}
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            name="inApp"
            className="mt-1 size-5 accent-[var(--accent)]"
            defaultChecked={initial.inApp}
            aria-describedby="prefs-inapp-hint"
          />
          <span>
            <span className="font-medium">{t.inApp}</span>
            <span id="prefs-inapp-hint" className="block text-sm text-muted-foreground">
              {t.inAppHint}
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            name="email"
            className="mt-1 size-5 accent-[var(--accent)]"
            defaultChecked={initial.email}
            aria-describedby="prefs-email-hint"
          />
          <span>
            <span className="font-medium">{t.email}</span>
            <span id="prefs-email-hint" className="block text-sm text-muted-foreground">
              {t.emailHint}
            </span>
          </span>
        </label>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">{t.kindsTitle}</legend>
          {NOTIFICATION_KINDS.map((k) => (
            <label key={k} className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                name={`kind-${k}`}
                className="mt-1 size-5 accent-[var(--accent)]"
                defaultChecked={initial.kinds.includes(k)}
                aria-describedby={`prefs-kind-${k}`}
              />
              <span>
                <span className="font-medium">{ro.notifications.kinds[k]}</span>
                <span id={`prefs-kind-${k}`} className="block text-sm text-muted-foreground">
                  {ro.notifications.kindHints[k]}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <div>
          <Button type="submit" disabled={!hydrated || pending} data-testid="prefs-save">
            {pending ? t.saving : t.save}
          </Button>
        </div>
      </form>
    </Card>
  );
}
