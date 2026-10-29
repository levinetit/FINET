"use client";

import { type FormEvent, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { ro } from "@/messages/ro";

import { goToLogin } from "@/app/_lib/api-client";
import { apiErrors } from "@/app/_lib/ledger-ui";
import { useHydrated } from "@/app/_lib/use-hydrated";
import { useSubmit } from "@/app/_lib/use-submit";

export type SwitcherHousehold = Readonly<{ id: string; name: string; current: boolean }>;

/**
 * Comutatorul gospodăriei active (Faza 8, ADR 0016): apare doar cu cel puțin două gospodării.
 * `PUT /api/v1/households/active` verifică apartenența în bază; după schimbare pagina se încarcă
 * complet la Acasă (starea clientului, inclusiv formularele, aparține gospodăriei vechi).
 */
export function HouseholdSwitcher({
  households,
}: Readonly<{ households: readonly SwitcherHousehold[] }>) {
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [error, setError] = useState<string | null>(null);
  const current = households.find((h) => h.current)?.id ?? households[0]?.id ?? "";
  const t = ro.family;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const householdId = String(new FormData(event.currentTarget).get("householdId") ?? "");
    if (!householdId || householdId === current) return;
    setError(null);
    const result = await submit(
      "/api/v1/households/active",
      "PUT",
      { householdId },
      {
        lockOnSuccess: true,
      },
    );
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(apiErrors(result).form);
      return;
    }
    const target = "/dashboard";
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- navigare completă intenționată: datele paginii aparțin altei gospodării
    window.location.assign(target);
  }

  if (households.length < 2) return null;
  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-wrap items-center justify-end gap-2"
      data-testid="household-switcher"
    >
      <label htmlFor="household-switch" className="text-sm text-muted-foreground">
        {t.switcherLabel}
      </label>
      <Select id="household-switch" name="householdId" defaultValue={current} className="w-auto">
        {households.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}
          </option>
        ))}
      </Select>
      <Button type="submit" size="sm" variant="outline" disabled={pending || !hydrated}>
        {pending ? t.switching : t.switch}
      </Button>
      <Alert className="w-full">{error}</Alert>
    </form>
  );
}
