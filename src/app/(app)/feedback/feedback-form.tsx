"use client";

import { type FormEvent, useState } from "react";

import { Field } from "@/components/ledger/field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { ro } from "@/messages/ro";

import { goToLogin } from "../../_lib/api-client";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

/** Formularul de feedback (`POST /api/v1/feedback`); ruta paginii nu se trimite (doar mesajul și tipul). */
export function FeedbackForm() {
  const t = ro.feedback;
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    setDone(false);
    const result = await submit("/api/v1/feedback", "POST", {
      kind: String(form.get("kind")),
      message: String(form.get("message") ?? ""),
    });
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) return setError(t.error);
    setDone(true);
    (event.target as HTMLFormElement).reset();
  }

  return (
    <Card aria-labelledby="feedback-form-title">
      <h2 id="feedback-form-title" className="sr-only">
        {t.title}
      </h2>
      <form method="post" onSubmit={onSubmit} aria-busy={pending}>
        <CardContent>
          <Field id="feedback-kind" label={t.kind} error={null}>
            {(p) => (
              <Select id={p.id} name="kind" defaultValue="feedback" data-testid="feedback-kind">
                <option value="feedback">{t.kinds.feedback}</option>
                <option value="bug">{t.kinds.bug}</option>
              </Select>
            )}
          </Field>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="feedback-message" className="font-medium">
              {t.message}
            </label>
            <textarea
              id="feedback-message"
              name="message"
              rows={6}
              minLength={3}
              maxLength={2000}
              required
              aria-describedby="feedback-hint"
              className="rounded-md border bg-surface p-3"
              data-testid="feedback-message"
            />
            <p id="feedback-hint" className="text-xs text-muted-foreground">
              {t.messageHint}
            </p>
          </div>
          <Alert>{error}</Alert>
          <Alert tone="ok" className={done ? undefined : "sr-only"}>
            {done ? t.thanks : null}
          </Alert>
          <div>
            <Button type="submit" disabled={pending || !hydrated} data-testid="feedback-submit">
              {pending ? t.sending : t.submit}
            </Button>
          </div>
        </CardContent>
      </form>
    </Card>
  );
}
