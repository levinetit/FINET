"use client";

import { type FormEvent, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ro } from "@/messages/ro";

import { apiFetch } from "../_lib/api-client";
import { safeNextPath } from "../_lib/next-path";

type Status = "idle" | "password" | "magic";

/** Mesajul pentru un 429: cu minutele din `Retry-After`, dacă există. */
function rateLimitMessage(retryAfter: number | null): string {
  return retryAfter ? ro.login.rateLimitedRetry(Math.ceil(retryAfter / 60)) : ro.login.rateLimited;
}

/**
 * Formularul de login: `POST /api/auth/sign-in/email` (JSON), prin intrarea FINET din
 * `src/modules/auth/handler.ts`, deci cu normalizarea emailului și rate limiting. Mesajele sunt
 * uniforme: nu spun dacă emailul are cont.
 */
export function LoginForm({ next, magicLink }: Readonly<{ next: string; magicLink: boolean }>) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    setInfo(null);
    if (!email || !password) {
      setError(ro.login.missingFields);
      return;
    }
    setStatus("password");
    setError(null);
    const result = await apiFetch("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password, rememberMe: true },
    });
    if (result.ok) {
      // Navigare completă: paginile server văd imediat cookie-ul de sesiune.
      window.location.assign(safeNextPath(next));
      return;
    }
    setStatus("idle");
    if (result.status === 429) setError(rateLimitMessage(result.retryAfter));
    else if (result.status === 400 || result.status === 401 || result.status === 403) {
      setError(ro.login.invalidCredentials);
    } else setError(ro.login.genericError);
  }

  async function onMagicLink(form: HTMLFormElement | null) {
    const email = String(new FormData(form ?? undefined).get("email") ?? "").trim();
    setInfo(null);
    if (!email) {
      setError(ro.login.magicLinkNeedsEmail);
      return;
    }
    setStatus("magic");
    setError(null);
    const result = await apiFetch("/api/auth/sign-in/magic-link", {
      method: "POST",
      body: { email, callbackURL: safeNextPath(next) },
    });
    setStatus("idle");
    if (result.status === 429) setError(rateLimitMessage(result.retryAfter));
    // Același mesaj pentru orice alt răspuns (fără enumerarea conturilor).
    else if (result.ok || result.status === 400) setInfo(ro.login.magicLinkSent);
    else setError(ro.login.genericError);
  }

  const busy = status !== "idle";
  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate aria-busy={busy}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="login-email">{ro.login.email}</Label>
        <Input
          id="login-email"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          required
          maxLength={254}
          aria-invalid={error ? true : undefined}
          aria-describedby="login-error"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="login-password">{ro.login.password}</Label>
        <Input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={128}
          aria-invalid={error ? true : undefined}
          aria-describedby="login-error"
        />
      </div>
      <Alert id="login-error">{error}</Alert>
      <Alert tone="ok">{info}</Alert>
      <Button type="submit" disabled={busy}>
        {status === "password" ? ro.login.submitting : ro.login.submit}
      </Button>
      {magicLink ? (
        <>
          <p className="text-center text-xs text-muted-foreground">{ro.login.or}</p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={(e) => void onMagicLink(e.currentTarget.form)}
          >
            {status === "magic" ? ro.login.magicLinkSending : ro.login.magicLink}
          </Button>
        </>
      ) : null}
    </form>
  );
}
