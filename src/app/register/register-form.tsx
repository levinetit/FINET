"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ro } from "@/messages/ro";

import { apiFetch } from "../_lib/api-client";
import { useHydrated } from "../_lib/use-hydrated";

import { TurnstileWidget } from "./turnstile-widget";

/**
 * Pasul 1 al înregistrării (ADR 0029): `POST /api/v1/register`. Răspunsul e același indiferent dacă
 * adresa are deja cont, deci mesajul de succes nu spune nimic despre asta.
 */
export function RegisterForm({ turnstileSiteKey }: Readonly<{ turnstileSiteKey: string | null }>) {
  const t = ro.register;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const hydrated = useHydrated();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    const acceptTerms = form.get("acceptTerms") === "on";
    if (!email || !name || !acceptTerms) {
      setError(t.missingFields);
      return;
    }
    if (turnstileSiteKey && !token) {
      setError(t.turnstileWait);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await apiFetch("/api/v1/register", {
      method: "POST",
      body: { email, name, acceptTerms: true, ...(token ? { turnstileToken: token } : {}) },
    });
    setBusy(false);
    if (result.ok) {
      setSent(true);
      return;
    }
    // Tokenul Turnstile e de unică folosință: după orice eșec, widgetul își cere unul nou.
    if (turnstileSiteKey) {
      setToken(null);
      setResetKey((k) => k + 1);
    }
    if (result.status === 429) setError(t.rateLimited);
    else if (result.status === 400 && result.error?.code === "turnstile")
      setError(t.turnstileFailed);
    else if (result.status === 400) setError(t.invalidFields);
    else setError(t.genericError);
  }

  if (sent) {
    return (
      <Alert tone="ok" data-testid="register-sent">
        {t.sent}
      </Alert>
    );
  }
  return (
    <form
      method="post"
      className="flex flex-col gap-4"
      onSubmit={onSubmit}
      noValidate
      aria-busy={busy}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="register-email">{t.email}</Label>
        <Input
          id="register-email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          maxLength={254}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="register-name">{t.name}</Label>
        <Input id="register-name" name="name" autoComplete="name" required maxLength={100} />
      </div>
      <div className="flex items-start gap-2">
        <input
          id="register-terms"
          name="acceptTerms"
          type="checkbox"
          required
          className="mt-1 size-4"
        />
        <Label htmlFor="register-terms" className="font-normal">
          {t.acceptTerms}{" "}
          <Link href="/terms" target="_blank">
            {t.termsLink}
          </Link>{" "}
          și{" "}
          <Link href="/privacy" target="_blank">
            {t.privacyLink}
          </Link>
          .
        </Label>
      </div>
      {turnstileSiteKey ? (
        <TurnstileWidget siteKey={turnstileSiteKey} onToken={setToken} resetKey={resetKey} />
      ) : null}
      <Alert id="register-error">{error}</Alert>
      <Button type="submit" disabled={busy || !hydrated || (turnstileSiteKey !== null && !token)}>
        {busy ? t.submitting : t.submit}
      </Button>
    </form>
  );
}
