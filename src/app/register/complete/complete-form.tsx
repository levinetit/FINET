"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ro } from "@/messages/ro";

import { apiFetch } from "../../_lib/api-client";
import { useHydrated } from "../../_lib/use-hydrated";

/** Pasul 2 al înregistrării (ADR 0029): linkul din email + parola aleasă, `POST /api/v1/register/complete`. */
export function CompleteForm({ token }: Readonly<{ token: string }>) {
  const t = ro.registerComplete;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [done, setDone] = useState(false);
  const hydrated = useHydrated();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== String(form.get("repeat") ?? "")) {
      setError(t.mismatch);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await apiFetch("/api/v1/register/complete", {
      method: "POST",
      body: { token, password },
    });
    setBusy(false);
    if (result.ok) setDone(true);
    else if (result.status === 410) setExpired(true);
    else if (result.status === 400 && result.error?.code === "password") {
      setError(result.error.message);
    } else if (result.status === 429) setError(ro.register.rateLimited);
    else setError(t.genericError);
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="ok" data-testid="register-done">
          {t.done}
        </Alert>
        <Link href="/login" className={buttonClasses()}>
          {t.goToLogin}
        </Link>
      </div>
    );
  }
  if (expired) {
    return (
      <div className="flex flex-col gap-4">
        <Alert data-testid="register-expired">{t.expired}</Alert>
        <Link href="/register" className={buttonClasses("outline")}>
          {t.restart}
        </Link>
      </div>
    );
  }
  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate aria-busy={busy}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="complete-password">{t.password}</Label>
        <Input
          id="complete-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          maxLength={128}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="complete-repeat">{t.passwordRepeat}</Label>
        <Input
          id="complete-repeat"
          name="repeat"
          type="password"
          autoComplete="new-password"
          required
          maxLength={128}
        />
      </div>
      <Alert id="complete-error">{error}</Alert>
      <Button type="submit" disabled={busy || !hydrated}>
        {busy ? t.submitting : t.submit}
      </Button>
    </form>
  );
}
