"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { ConfirmButton } from "@/components/ledger/confirm-button";
import { Field } from "@/components/ledger/field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { ro } from "@/messages/ro";

import { goToLogin } from "../../_lib/api-client";
import { formatInstant, joinLink } from "../../_lib/family-ui";
import { apiErrors } from "../../_lib/ledger-ui";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

type Invite = Readonly<{
  id: string;
  role: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}>;

type Created = Readonly<{ invite: { id: string }; token: string; joinPath: string }>;

/**
 * Invitațiile (doar owner, Faza 8): crearea întoarce linkul O SINGURĂ DATĂ; el stă doar în
 * memoria acestei componente (nu în URL, nu în stocarea browserului) și dispare la reîncărcare.
 * Lista arată starea, fără tokenuri (în bază e doar hash-ul). Crearea NU folosește
 * `Idempotency-Key` (răspunsul memorat ar conține tokenul); dublu-clicul e blocat de `useSubmit`.
 */
export function InvitesPanel({ invites }: Readonly<{ invites: readonly Invite[] }>) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<string | null>(null);
  const t = ro.family;
  const busy = pending || !hydrated;

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    setLink(null);
    setCopyState(null);
    const result = await submit<Created>("/api/v1/family/invites", "POST", {
      role: String(form.get("role") ?? "member"),
      expiresInHours: Number.parseInt(String(form.get("hours") ?? "72"), 10),
    });
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok || !result.data) {
      setError(apiErrors(result).form);
      return;
    }
    setLink(joinLink(window.location.origin, result.data.joinPath));
    router.refresh();
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopyState(t.copied);
    } catch {
      setCopyState(t.copyFailed);
    }
  }

  async function revoke(id: string) {
    setError(null);
    const result = await submit(`/api/v1/family/invites/${id}/revoke`, "POST");
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(apiErrors(result).form);
      return;
    }
    router.refresh();
  }

  return (
    <Card data-testid="family-invites">
      <CardHeader>
        <CardTitle>{t.invitesTitle}</CardTitle>
        <CardDescription>{t.invitesHint}</CardDescription>
      </CardHeader>
      <form onSubmit={onCreate} noValidate aria-busy={pending} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field id="invite-role" label={t.inviteRole}>
            {(p) => (
              <Select id={p.id} name="role" defaultValue="member">
                <option value="member">{t.roles.member}</option>
                <option value="owner">{t.roles.owner}</option>
              </Select>
            )}
          </Field>
          <Field id="invite-hours" label={t.inviteHours}>
            {(p) => (
              <Select id={p.id} name="hours" defaultValue="72">
                {t.inviteHoursOptions.map((o) => (
                  <option key={o.value} value={String(o.value)}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div>
          <Button type="submit" disabled={busy} data-testid="invite-create">
            {pending ? t.creatingInvite : t.createInvite}
          </Button>
        </div>
      </form>
      {link ? (
        <div className="flex flex-col gap-2 rounded-md border border-ok bg-ok-soft p-3">
          <p className="text-sm">{t.inviteCreated}</p>
          <Field id="invite-link" label={t.inviteLink}>
            {(p) => (
              <Input
                id={p.id}
                readOnly
                value={link}
                onFocus={(e) => e.currentTarget.select()}
                data-testid="invite-link"
              />
            )}
          </Field>
          <div>
            <Button size="sm" variant="outline" onClick={() => void copy()}>
              {t.copy}
            </Button>
          </div>
          <Alert tone="info">{copyState}</Alert>
        </div>
      ) : null}
      <Alert>{error}</Alert>
      {invites.length === 0 ? (
        <p className="text-muted-foreground">{t.noInvites}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border" data-testid="invite-list">
          {invites.map((i) => (
            <li
              key={i.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
              data-testid="invite-row"
              data-invite-status={i.status}
            >
              <span>
                {t.roles[i.role] ?? i.role} · {t.inviteStatus[i.status] ?? i.status}
                {i.status === "active" ? ` · ${t.expiresAt(formatInstant(i.expiresAt))}` : ""}
              </span>
              {i.status === "active" ? (
                <ConfirmButton
                  label={t.revoke}
                  question={t.revokeConfirm}
                  confirmLabel={t.revokeYes}
                  busy={busy}
                  onConfirm={() => void revoke(i.id)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
