"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConfirmButton } from "@/components/ledger/confirm-button";
import { Field } from "@/components/ledger/field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ro } from "@/messages/ro";
import type { ListJson, ListWithItemsJson } from "@/modules/shopping/shopping.schema";

import { goToLogin } from "../../_lib/api-client";
import { apiErrors } from "../../_lib/ledger-ui";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

/**
 * Acțiunile pe listă (F10-A): redenumire, arhivare/reactivare, copiere, „fă lista comună” (doar o
 * listă personală, într-un singur sens) și ștergere cu confirmare. Mutațiile merg prin API.
 */
export function ListActions({ list }: Readonly<{ list: ListJson }>) {
  const t = ro.shopping;
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [name, setName] = useState(list.name);
  const base = `/api/v1/shopping-lists/${list.id}`;

  async function run(
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body: unknown,
    done: (data: unknown) => void,
    idempotent = false,
  ) {
    setError(null);
    setInfo(null);
    const result = await submit(path, method, body, { idempotent });
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(apiErrors(result).form);
      return;
    }
    done(result.data);
  }

  const busy = pending || !hydrated;
  return (
    <div className="flex flex-col gap-3" role="group" aria-label={t.listMenu}>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const next = name.trim();
          if (next.length < 1 || next.length > 100) return setError(t.invalidName);
          void run(base, "PATCH", { name: next }, () => {
            setInfo(null);
            router.refresh();
          });
        }}
      >
        <Field id={`rename-${list.id}`} label={t.rename} className="min-w-48 flex-1">
          {(p) => (
            <Input
              id={p.id}
              value={name}
              maxLength={100}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
              data-testid="rename-input"
            />
          )}
        </Field>
        <Button type="submit" variant="outline" disabled={busy || name.trim() === list.name}>
          {t.save}
        </Button>
      </form>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(
              base,
              "PATCH",
              { status: list.status === "active" ? "archived" : "active" },
              () => router.refresh(),
            )
          }
          data-testid="archive-toggle"
        >
          {list.status === "active" ? t.archive : t.unarchive}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(
              `${base}/copy`,
              "POST",
              {},
              (data) => {
                setInfo(t.copied);
                const created = data as ListWithItemsJson | null;
                if (created) router.push(`/shopping-lists/${created.list.id}`);
              },
              true,
            )
          }
          data-testid="copy-list"
        >
          {t.copy}
        </Button>
        {list.shared ? null : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            title={t.shareHint}
            onClick={() => void run(base, "PATCH", { shared: true }, () => router.refresh())}
            data-testid="share-list"
          >
            {t.share}
          </Button>
        )}
        <ConfirmButton
          label={t.deleteList}
          question={t.deleteQuestion}
          busy={pending}
          disabled={!hydrated}
          onConfirm={() =>
            void run(base, "DELETE", undefined, () => {
              router.push("/shopping-lists");
              router.refresh();
            })
          }
        />
      </div>
      <Alert>{error}</Alert>
      <Alert tone="ok">{info}</Alert>
    </div>
  );
}
