"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ro } from "@/messages/ro";
import type { DeletionPreview } from "@/modules/gdpr/gdpr.schema";

import { apiFetch, goToLogin } from "../../../_lib/api-client";
import { clearOfflineScans } from "../../../_lib/offline-scans-idb";
import { useHydrated } from "../../../_lib/use-hydrated";

/**
 * Ștergerea contului (Faza 9, ADR 0021): întâi previzualizarea (`GET /api/v1/me/deletion`, ce se
 * șterge / ce se părăsește / ce blochează), apoi parola + „ȘTERGE” → `POST /api/v1/me/delete`.
 * Toate regulile sunt pe server; aici doar ajutor (butonul blocat cât timp ștergerea ar fi
 * refuzată). După succes: coada offline din IndexedDB se golește și pagina merge la login.
 */
export function DeleteAccount() {
  const t = ro.privacy;
  const hydrated = useHydrated();
  const lock = useRef(false);
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Partial<Record<"password" | "confirm", string>>>({});

  useEffect(() => {
    let alive = true;
    void apiFetch<DeletionPreview>("/api/v1/me/deletion", { method: "GET" }).then((r) => {
      if (!alive) return;
      if (r.status === 401) return goToLogin();
      if (r.ok && r.data) setPreview(r.data);
      else setLoadError(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current || !preview) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirm = String(form.get("confirm") ?? "").trim();
    setError(null);
    if (confirm !== t.confirmWord) {
      setFields({ confirm: t.confirmMismatch });
      return;
    }
    setFields({});
    lock.current = true;
    setBusy(true);
    try {
      const r = await apiFetch("/api/v1/me/delete", {
        method: "POST",
        body: preview.hasPassword ? { password, confirm } : { confirm },
      });
      if (r.ok) {
        await clearOfflineScans().catch(() => undefined);
        // Navigare completă: sesiunea nu mai există, starea clientului se golește.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- sesiunea a dispărut odată cu contul
        window.location.assign("/login");
        return;
      }
      if (r.status === 401) return goToLogin();
      const code = r.error?.code;
      if (code === "invalid_password") setFields({ password: t.wrongPassword });
      else if (code === "reauth_required") setError(t.reauth);
      else if (code === "last_owner") setError(t.lastOwner);
      else if (code === "platform_admin") setError(t.platformAdmin);
      else if (r.status === 429) setError(ro.login.rateLimited);
      else setError(t.error);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  if (loadError) return <Alert>{t.loadError}</Alert>;
  if (!preview) return <p aria-live="polite">{t.loading}</p>;
  const blocked = preview.blockedHouseholds.length > 0 || preview.platformAdmin;

  return (
    <div className="flex flex-col gap-4" data-testid="delete-account">
      {preview.deletedHouseholds.length > 0 ? (
        <div>
          <p>{t.deletedList}</p>
          <ul className="list-disc pl-5" data-testid="deleted-households">
            {preview.deletedHouseholds.map((h) => (
              <li key={h.id}>{h.name}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {preview.leftHouseholds.length > 0 ? (
        <div>
          <p>{t.leftList}</p>
          <ul className="list-disc pl-5" data-testid="left-households">
            {preview.leftHouseholds.map((h) => (
              <li key={h.id}>
                {h.name}
                {h.unsettled ? ` (${t.unsettled})` : ""}
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">{t.history}</p>
        </div>
      ) : null}
      {preview.platformAdmin ? (
        <Alert tone="info" data-testid="platform-admin">
          {t.platformAdmin}
        </Alert>
      ) : null}
      {preview.blockedHouseholds.length > 0 ? (
        <Alert tone="info">
          <span>{t.blockedList}</span>
          <ul className="list-disc pl-5" data-testid="blocked-households">
            {preview.blockedHouseholds.map((h) => (
              <li key={h.id}>{h.name}</li>
            ))}
          </ul>
          <Link href="/family" className={buttonClasses("outline", "sm")}>
            {t.familyLink}
          </Link>
        </Alert>
      ) : null}
      <form
        method="post"
        onSubmit={onSubmit}
        noValidate
        aria-busy={busy}
        className="flex flex-col gap-4"
      >
        {preview.hasPassword ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="del-password">{t.password}</Label>
            <Input
              id="del-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
              aria-invalid={fields.password ? true : undefined}
              aria-describedby="del-password-error"
            />
            <p
              id="del-password-error"
              aria-live="polite"
              className={fields.password ? "text-sm text-bad" : "sr-only"}
            >
              {fields.password ?? ""}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t.noPassword}</p>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="del-confirm">{t.confirmLabel}</Label>
          <Input
            id="del-confirm"
            name="confirm"
            type="text"
            autoComplete="off"
            required
            maxLength={20}
            aria-invalid={fields.confirm ? true : undefined}
            aria-describedby="del-confirm-error"
          />
          <p
            id="del-confirm-error"
            aria-live="polite"
            className={fields.confirm ? "text-sm text-bad" : "sr-only"}
          >
            {fields.confirm ?? ""}
          </p>
        </div>
        <Alert>{error}</Alert>
        <div>
          <Button
            type="submit"
            variant="destructive"
            disabled={busy || !hydrated || blocked}
            data-testid="delete-account-submit"
          >
            {busy ? t.submitting : t.submit}
          </Button>
        </div>
      </form>
    </div>
  );
}
