"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ro } from "@/messages/ro";

import { apiFetch, goToLogin } from "../../_lib/api-client";

const MIN_LENGTH = 10;

type Fields = Partial<Record<"currentPassword" | "newPassword" | "confirm", string>>;

/**
 * Schimbarea parolei: `POST /api/v1/me/password` (parola curentă, politica, rate limiting,
 * revocarea celorlalte sesiuni, audit, toate pe server). Verificările de aici sunt doar ajutor.
 */
export function PasswordForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Fields>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const currentPassword = String(form.get("currentPassword") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");
    const confirm = String(form.get("confirm") ?? "");
    setDone(null);
    setError(null);
    if ([...newPassword].length < MIN_LENGTH) {
      setFields({ newPassword: ro.password.tooShort });
      return;
    }
    if (newPassword !== confirm) {
      setFields({ confirm: ro.password.mismatch });
      return;
    }
    setFields({});
    setBusy(true);
    const result = await apiFetch<{ revokedSessions: number }>("/api/v1/me/password", {
      method: "POST",
      body: { currentPassword, newPassword },
    });
    setBusy(false);
    if (result.status === 401) return goToLogin();
    if (result.ok) {
      formEl.reset();
      setDone(ro.password.done(result.data?.revokedSessions ?? 0));
      router.refresh();
      return;
    }
    if (result.status === 429) {
      setError(ro.login.rateLimited);
      return;
    }
    const f = result.error?.fields ?? {};
    if (f.currentPassword || f.newPassword) {
      setFields({ currentPassword: f.currentPassword, newPassword: f.newPassword });
    } else setError(ro.password.error);
  }

  const field = (
    id: keyof Fields,
    label: string,
    autoComplete: "current-password" | "new-password",
  ) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`pw-${id}`}>{label}</Label>
      <Input
        id={`pw-${id}`}
        name={id}
        type="password"
        autoComplete={autoComplete}
        required
        maxLength={128}
        aria-invalid={fields[id] ? true : undefined}
        aria-describedby={`pw-${id}-error`}
      />
      <p
        id={`pw-${id}-error`}
        aria-live="polite"
        className={fields[id] ? "text-sm text-bad" : "sr-only"}
      >
        {fields[id] ?? ""}
      </p>
    </div>
  );

  return (
    <Card aria-labelledby="password-title">
      <CardHeader>
        <CardTitle id="password-title">{ro.password.title}</CardTitle>
        <CardDescription>{ro.password.hint}</CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit} noValidate aria-busy={busy}>
        <CardContent>
          {field("currentPassword", ro.password.current, "current-password")}
          {field("newPassword", ro.password.next, "new-password")}
          {field("confirm", ro.password.confirm, "new-password")}
          <Alert>{error}</Alert>
          <Alert tone="ok">{done}</Alert>
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? ro.password.submitting : ro.password.submit}
            </Button>
          </div>
        </CardContent>
      </form>
    </Card>
  );
}
