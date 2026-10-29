"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { Field } from "@/components/ledger/field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { ro } from "@/messages/ro";

import { goToLogin } from "../../_lib/api-client";
import { apiErrors } from "../../_lib/ledger-ui";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

export type ChooserOption = Readonly<{ id: string; label: string }>;

/**
 * Alegerea perechii (listă, bon) și rularea comparației (`POST …/comparisons`, care doar PROPUNE
 * potrivirile), apoi deschide ecranul „Comparație cu bonul”. Folosit din listă (se alege bonul,
 * `mode="receipt"`) și din bon (se alege lista, `mode="list"`).
 */
export function CompareChooser({
  mode,
  fixedId,
  options,
  initialId,
}: Readonly<{
  mode: "receipt" | "list";
  /** Id-ul fix: lista (`mode="receipt"`) sau bonul (`mode="list"`). */
  fixedId: string;
  options: readonly ChooserOption[];
  initialId?: string;
}>) {
  const t = ro.shopping;
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [chosen, setChosen] = useState(initialId ?? "");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chosen) return;
    setError(null);
    const listId = mode === "receipt" ? fixedId : chosen;
    const receiptId = mode === "receipt" ? chosen : fixedId;
    const result = await submit(`/api/v1/shopping-lists/${listId}/comparisons`, "POST", {
      receiptId,
    });
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(apiErrors(result).form);
      return;
    }
    router.push(`/shopping-lists/${listId}/compare?receipt=${receiptId}`);
    router.refresh();
  }

  if (options.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="compare-none">
        {mode === "receipt" ? t.noReceipts : t.noLists}
      </p>
    );
  }
  return (
    <form
      method="post"
      onSubmit={onSubmit}
      className="flex flex-wrap items-end gap-3"
      aria-busy={pending}
    >
      <Field
        id={`compare-${mode}-${fixedId}`}
        label={mode === "receipt" ? t.chooseReceipt : t.chooseList}
        className="min-w-56 flex-1"
      >
        {(p) => (
          <Select
            id={p.id}
            value={chosen}
            onChange={(e) => setChosen(e.target.value)}
            data-testid="compare-select"
          >
            <option value="">
              {mode === "receipt" ? t.chooseReceiptPlaceholder : t.chooseListPlaceholder}
            </option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button type="submit" disabled={!chosen || pending || !hydrated} data-testid="compare-submit">
        {pending ? t.comparing : t.compare}
      </Button>
      <div className="w-full">
        <Alert>{error}</Alert>
      </div>
    </form>
  );
}
