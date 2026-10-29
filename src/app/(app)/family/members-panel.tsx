"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConfirmButton } from "@/components/ledger/confirm-button";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ro } from "@/messages/ro";

import { goToLogin } from "../../_lib/api-client";
import { formatInstant } from "../../_lib/family-ui";
import { apiErrors } from "../../_lib/ledger-ui";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

type Member = Readonly<{
  userId: string;
  name: string;
  displayName: string;
  role: string;
  joinedAt: string;
  /** Decontările active la care e parte (mitigarea din ADR 0016 §10). */
  activeSettlements?: number;
}>;

/** După plecare: pagină completă la Acasă (gospodăria activă s-a schimbat). */
function goHome() {
  const target = "/dashboard";
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- navigare completă intenționată: gospodăria activă s-a schimbat
  window.location.assign(target);
}

/**
 * Membrii (Faza 8): rolul fiecăruia; un owner schimbă rolurile, predă rolul de proprietar și scoate
 * membri; oricine pleacă. Ultimul owner nu pleacă și nu e retrogradat (409 `last_owner`, mesajul
 * din `ro.ledger.errors.reasons`). Plecarea/eliminarea cu solduri nedecontate NU e blocată: răspunsul
 * `unsettledBalance` dă un avertisment (soldurile rămân în istoric, cu „fost membru”).
 */
export function MembersPanel({
  members,
  meUserId,
  isOwner,
}: Readonly<{ members: readonly Member[]; meUserId: string; isOwner: boolean }>) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const t = ro.family;
  const busy = pending || !hydrated;

  async function run(
    path: string,
    method: "PATCH" | "DELETE" | "POST",
    body: unknown,
    after: (data: unknown) => void,
  ) {
    setError(null);
    setInfo(null);
    const result = await submit<unknown>(path, method, body);
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(apiErrors(result).form);
      return;
    }
    after(result.data);
  }

  const unsettled = (data: unknown) =>
    Boolean(
      data && typeof data === "object" && (data as { unsettledBalance?: boolean }).unsettledBalance,
    );

  return (
    <Card data-testid="family-members">
      <CardHeader>
        <CardTitle>{t.membersTitle}</CardTitle>
        <CardDescription>{t.membersHint}</CardDescription>
      </CardHeader>
      <ul className="flex flex-col divide-y divide-border">
        {members.map((m) => {
          const self = m.userId === meUserId;
          return (
            <li
              key={m.userId}
              className="flex flex-col gap-2 py-3"
              data-testid="family-member"
              data-member-name={m.name}
            >
              <span className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold">{m.displayName}</span>
                <span className="text-sm text-muted-foreground">
                  {t.roles[m.role] ?? m.role} · {t.joinedOn(formatInstant(m.joinedAt))}
                </span>
              </span>
              <span className="flex flex-wrap gap-2">
                {isOwner && !self ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          `/api/v1/family/members/${m.userId}`,
                          "PATCH",
                          { role: m.role === "owner" ? "member" : "owner" },
                          () => {
                            setInfo(t.roleSaved);
                            router.refresh();
                          },
                        )
                      }
                    >
                      {m.role === "owner" ? t.makeMember : t.makeOwner}
                    </Button>
                    {m.role !== "owner" ? (
                      <ConfirmButton
                        label={t.transferOwnership}
                        question={t.transferConfirm}
                        confirmLabel={t.transferYes}
                        busy={busy}
                        onConfirm={() =>
                          void run(
                            `/api/v1/family/members/${m.userId}/transfer-ownership`,
                            "POST",
                            undefined,
                            () => {
                              setInfo(t.roleSaved);
                              router.refresh();
                            },
                          )
                        }
                      />
                    ) : null}
                    <ConfirmButton
                      label={t.remove}
                      question={
                        m.activeSettlements
                          ? `${t.removeConfirm} ${t.removeActiveSettlements(m.activeSettlements)}`
                          : t.removeConfirm
                      }
                      confirmLabel={t.removeYes}
                      busy={busy}
                      onConfirm={() =>
                        void run(`/api/v1/family/members/${m.userId}`, "DELETE", undefined, (d) => {
                          setInfo(unsettled(d) ? t.removedUnsettled : t.removed);
                          router.refresh();
                        })
                      }
                    />
                  </>
                ) : null}
                {self && members.length > 1 ? (
                  <ConfirmButton
                    label={t.leave}
                    question={t.leaveConfirm}
                    confirmLabel={t.leaveYes}
                    busy={busy}
                    onConfirm={() =>
                      void run("/api/v1/family/leave", "POST", undefined, (d) => {
                        if (unsettled(d)) {
                          // Avertismentul rămâne vizibil o clipă, apoi pagina completă (altă gospodărie).
                          setInfo(t.leaveUnsettled);
                          setTimeout(goHome, 2500);
                          return;
                        }
                        goHome();
                      })
                    }
                  />
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      <Alert>{error}</Alert>
      <Alert tone="info" data-testid="family-members-info">
        {info}
      </Alert>
    </Card>
  );
}
