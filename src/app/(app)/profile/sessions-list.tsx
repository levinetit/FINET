"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ro } from "@/messages/ro";

import { apiFetch, goToLogin } from "../../_lib/api-client";

export type SessionRow = Readonly<{
  id: string;
  device: string;
  platform: "android" | "web";
  ipAddress: string | null;
  current: boolean;
  /** Formatate pe server, în fusul orar al utilizatorului. */
  lastActive: string;
  created: string;
}>;

/**
 * Lista sesiunilor active (`GET /api/v1/me/sessions`, citită pe server) cu revocare individuală
 * (`DELETE /api/v1/me/sessions/{id}`) și „Deconectează celelalte”
 * (`POST /api/v1/me/sessions/revoke-others`). Ambele cer o confirmare.
 */
export function SessionsList({ sessions }: Readonly<{ sessions: SessionRow[] }>) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const others = sessions.filter((s) => !s.current);

  async function revoke(row: SessionRow) {
    setBusy(true);
    setError(null);
    setInfo(null);
    const result = await apiFetch(`/api/v1/me/sessions/${encodeURIComponent(row.id)}`, {
      method: "DELETE",
    });
    setBusy(false);
    setConfirming(null);
    if (result.status === 401 || (result.ok && row.current)) return goToLogin();
    if (!result.ok && result.status !== 404) {
      setError(ro.sessions.error);
      return;
    }
    setInfo(ro.sessions.revoked);
    router.refresh();
  }

  async function revokeOthers() {
    setBusy(true);
    setError(null);
    setInfo(null);
    const result = await apiFetch<{ revoked: number }>("/api/v1/me/sessions/revoke-others", {
      method: "POST",
      body: {},
    });
    setBusy(false);
    setConfirming(null);
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(ro.sessions.error);
      return;
    }
    setInfo(ro.sessions.revokedOthers(result.data?.revoked ?? 0));
    router.refresh();
  }

  return (
    <Card aria-labelledby="sessions-title">
      <CardHeader>
        <CardTitle id="sessions-title">{ro.sessions.title}</CardTitle>
        <CardDescription>{ro.sessions.hint}</CardDescription>
      </CardHeader>
      <ul className="flex flex-col divide-y divide-border" aria-label={ro.sessions.title}>
        {sessions.map((row) => (
          <li
            key={row.id}
            className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
            data-testid="session-row"
            data-current={row.current ? "true" : undefined}
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-semibold">
                {row.device}
                {row.current ? (
                  <span className="ml-2 rounded bg-accent px-1.5 py-0.5 text-xs font-semibold text-accent-foreground">
                    {ro.sessions.current}
                  </span>
                ) : null}
              </span>
              <span className="text-sm text-muted-foreground">
                {ro.sessions.lastActive}: {row.lastActive} · {ro.sessions.created}: {row.created}
                {row.ipAddress ? ` · ${ro.sessions.ip} ${row.ipAddress}` : ""}
              </span>
            </div>
            {row.current ? null : confirming === row.id ? (
              <div className="flex flex-wrap items-center gap-2" role="group">
                <span className="text-sm">{ro.sessions.revokeConfirm}</span>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void revoke(row)}
                >
                  {busy ? ro.sessions.revoking : ro.sessions.confirm}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                  {ro.sessions.cancel}
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setConfirming(row.id)}
                aria-label={`${ro.sessions.revoke}: ${row.device}, ${row.lastActive}`}
              >
                {ro.sessions.revoke}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {others.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{ro.sessions.empty}</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {confirming === "others" ? (
            <>
              <span className="text-sm">{ro.sessions.revokeOthersConfirm}</span>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => void revokeOthers()}
              >
                {busy ? ro.sessions.revoking : ro.sessions.confirm}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                {ro.sessions.cancel}
              </Button>
            </>
          ) : (
            <Button variant="outline" disabled={busy} onClick={() => setConfirming("others")}>
              {ro.sessions.revokeOthers}
            </Button>
          )}
        </div>
      )}
      <Alert className="mt-3">{error}</Alert>
      <Alert tone="ok" className="mt-3">
        {info}
      </Alert>
    </Card>
  );
}
