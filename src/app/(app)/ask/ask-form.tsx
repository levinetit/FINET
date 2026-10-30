"use client";

import { type FormEvent, useRef, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ro } from "@/messages/ro";
import type { AskResult } from "@/modules/ask/ask.service";

import { apiFetch, goToLogin } from "../../_lib/api-client";
import { formatMinor } from "../../_lib/ledger-ui";
import { useHydrated } from "../../_lib/use-hydrated";

const MAX = 300;
const MIN = 3;

/** Formularul „Întreabă FINET”: `POST /api/v1/ask`; întrebarea nu se păstrează nicăieri. */
export function AskForm() {
  const t = ro.ask;
  const hydrated = useHydrated();
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskResult | null>(null);

  async function run(text: string) {
    const trimmed = text.trim();
    if (trimmed.length < MIN) return setError(t.tooShort);
    if (trimmed.length > MAX) return setError(t.tooLong);
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await apiFetch<AskResult>("/api/v1/ask", {
        method: "POST",
        body: { question: trimmed },
      });
      if (response.status === 401) return goToLogin();
      if (response.status === 429) return setError(t.rateLimited);
      if (!response.ok || !response.data) return setError(t.error);
      setResult(response.data);
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(question);
  }

  return (
    <div className="flex flex-col gap-4">
      <Card aria-labelledby="ask-title">
        <CardHeader>
          <CardTitle id="ask-title">{t.title}</CardTitle>
        </CardHeader>
        <form method="post" onSubmit={onSubmit} noValidate aria-busy={pending}>
          <CardContent>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ask-question">{t.label}</Label>
              <Input
                id="ask-question"
                name="question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                maxLength={MAX}
                autoComplete="off"
                placeholder={t.placeholder}
                data-testid="ask-question"
              />
            </div>
            <Alert>{error}</Alert>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={pending || !hydrated} data-testid="ask-submit">
                {pending ? t.asking : t.submit}
              </Button>
            </div>
            <div>
              <p className="mb-2 text-sm font-semibold">{t.examplesTitle}</p>
              <ul className="flex flex-wrap gap-2">
                {t.examples.map((example) => (
                  <li key={example}>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={pending || !hydrated}
                      onClick={() => {
                        setQuestion(example);
                        void run(example);
                      }}
                    >
                      {example}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </form>
      </Card>

      {result ? <AskAnswerCard result={result} /> : null}
    </div>
  );
}

function AskAnswerCard({ result }: Readonly<{ result: AskResult }>) {
  const t = ro.ask;
  if (!result.understood) {
    return (
      <Card aria-labelledby="ask-not-understood" data-testid="ask-not-understood">
        <CardHeader>
          <CardTitle id="ask-not-understood">{t.notUnderstoodTitle}</CardTitle>
        </CardHeader>
        <p>{result.message}</p>
      </Card>
    );
  }
  return (
    <Card aria-labelledby="ask-answer" data-testid="ask-answer">
      <CardHeader>
        <CardTitle id="ask-answer">{t.answerTitle}</CardTitle>
      </CardHeader>
      <p className="text-lg" data-testid="ask-text">
        {result.text}
      </p>
      {result.notes.map((note) => (
        <p key={note} className="mt-2 text-sm text-muted-foreground">
          {note}
        </p>
      ))}
      {result.answer.kind === "ranking" ? (
        <div className="mt-3 flex flex-col gap-3">
          {result.answer.rows.length === 0 ? <p>{t.noRows}</p> : null}
          {result.answer.rows.map((row) => (
            <table key={row.currency} className="w-full text-sm">
              <caption className="mb-1 text-left font-semibold">{row.currency}</caption>
              <tbody>
                {row.items.map((item, i) => (
                  <tr key={`${item.name ?? "-"}-${i}`} className="border-t">
                    <td className="py-1.5 pr-3">{item.name ?? "Fără categorie"}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums">
                      {formatMinor(item.amountMinor, row.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>
      ) : null}
      <p className="mt-4 text-sm font-semibold">{t.queryTitle}</p>
      <p className="text-sm text-muted-foreground" data-testid="ask-query">
        {result.queryText}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">{t.note}</p>
    </Card>
  );
}
