"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { Field } from "@/components/ledger/field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ro } from "@/messages/ro";
import type { ItemJson } from "@/modules/shopping/shopping.schema";

import { apiFetch, goToLogin } from "../../_lib/api-client";
import { apiErrors } from "../../_lib/ledger-ui";
import { moveId, parseQuantityInput, quantityLabel } from "../../_lib/shopping-ui";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

const NAME_MAX = 120;
const UNIT_MAX = 20;

type Draft = { name: string; quantity: string; unit: string; note: string };

/**
 * Lista de cumpărături interactivă (F10-A, ADR 0022). Mod „la raft” (mobil-first, ținte mari):
 * un tap pe articol îl bifează OPTIMIST (`PATCH …/items/{id}` cu `checked`: stare explicită,
 * idempotentă); la eroare starea revine și apare mesajul („fără conexiune” pentru rețea căzută:
 * service worker-ul nu cache-uiește date și nu există coadă offline pentru liste). Actualizările
 * celorlalți membri vin prin fluxul live al aplicației (`router.refresh()` → alte `initialItems`);
 * cât timp o cerere e în zbor, reîncărcarea nu suprascrie starea optimistă.
 */
export function ShoppingList({
  listId,
  initialItems,
  suggestions,
  readOnly = false,
}: Readonly<{
  listId: string;
  initialItems: readonly ItemJson[];
  suggestions: readonly string[];
  /** Listă arhivată: se poate citi și bifa, nu se mai adaugă articole. */
  readOnly?: boolean;
}>) {
  const t = ro.shopping;
  const ids = useId();
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending: adding } = useSubmit();
  const [items, setItems] = useState<readonly ItemJson[]>(initialItems);
  const [shelf, setShelf] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addErrors, setAddErrors] = useState<{ name?: string; quantity?: string }>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ name: "", quantity: "", unit: "", note: "" });
  const inflight = useRef(0);
  const nameInput = useRef<HTMLInputElement>(null);
  const base = `/api/v1/shopping-lists/${listId}`;

  // Datele noi de la server (reîncărcare după un eveniment live) înlocuiesc starea locală, dar nu
  // peste o modificare în zbor.
  useEffect(() => {
    if (inflight.current === 0) setItems(initialItems);
  }, [initialItems]);

  function fail(status: number, reasonText?: string | null) {
    if (status === 401) return goToLogin();
    setError(status === 0 ? t.offline : (reasonText ?? t.saveError));
  }

  async function toggle(item: ItemJson) {
    const next = !item.checked;
    setError(null);
    inflight.current += 1;
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, checked: next } : i)));
    const result = await apiFetch<ItemJson>(`${base}/items/${item.id}`, {
      method: "PATCH",
      body: { checked: next },
    });
    inflight.current -= 1;
    if (result.ok && result.data) {
      const saved = result.data;
      setItems((prev) => prev.map((i) => (i.id === saved.id ? saved : i)));
    } else {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, checked: item.checked } : i)));
      fail(result.status, result.status === 404 ? apiErrors(result).form : undefined);
    }
  }

  async function move(item: ItemJson, delta: -1 | 1) {
    const order = moveId(
      items.map((i) => i.id),
      item.id,
      delta,
    );
    if (order.every((id, k) => id === items[k]?.id)) return;
    setError(null);
    const before = items;
    const byId = new Map(items.map((i) => [i.id, i]));
    inflight.current += 1;
    setItems(order.map((id) => byId.get(id)!));
    const result = await apiFetch<{ items: ItemJson[] }>(`${base}/order`, {
      method: "PUT",
      body: { itemIds: order },
    });
    inflight.current -= 1;
    if (result.ok && result.data) {
      setItems(result.data.items);
    } else {
      setItems(before);
      fail(result.status, apiErrors(result).form);
      if (result.status === 409) router.refresh();
    }
  }

  async function remove(item: ItemJson) {
    setError(null);
    const result = await apiFetch(`${base}/items/${item.id}`, { method: "DELETE" });
    if (result.ok) setItems((prev) => prev.filter((i) => i.id !== item.id));
    else fail(result.status, apiErrors(result).form);
  }

  async function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const name = String(form.get("name") ?? "").trim();
    const quantity = parseQuantityInput(String(form.get("quantity") ?? ""));
    const unit = String(form.get("unit") ?? "").trim();
    const errors: { name?: string; quantity?: string } = {};
    if (name.length < 1 || name.length > NAME_MAX || !/[\p{L}\p{N}]/u.test(name)) {
      errors.name = t.invalidItem;
    }
    if (quantity === null) errors.quantity = t.invalidQuantity;
    setAddErrors(errors);
    if (errors.name || errors.quantity) return;
    setError(null);
    const result = await submit<ItemJson>(
      `${base}/items`,
      "POST",
      { name, ...(quantity ? { quantity } : {}), ...(unit ? { unit } : {}) },
      { idempotent: true },
    );
    if (!result) return;
    if (!result.ok || !result.data) return fail(result.status, apiErrors(result).form);
    const created = result.data;
    setItems((prev) => [...prev, created]);
    formEl.reset();
    nameInput.current?.focus();
  }

  function startEdit(item: ItemJson) {
    setEditing(item.id);
    setDraft({
      name: item.name,
      quantity: item.quantity,
      unit: item.unit ?? "",
      note: item.note ?? "",
    });
  }

  async function saveEdit(item: ItemJson) {
    const quantity = parseQuantityInput(draft.quantity);
    if (draft.name.trim() === "" || quantity === null) {
      setError(quantity === null ? t.invalidQuantity : t.invalidItem);
      return;
    }
    setError(null);
    const result = await apiFetch<ItemJson>(`${base}/items/${item.id}`, {
      method: "PATCH",
      body: {
        name: draft.name.trim(),
        ...(quantity ? { quantity } : {}),
        unit: draft.unit.trim() || null,
        note: draft.note.trim() || null,
      },
    });
    if (result.ok && result.data) {
      const saved = result.data;
      setItems((prev) => prev.map((i) => (i.id === saved.id ? saved : i)));
      setEditing(null);
    } else {
      fail(result.status, apiErrors(result).form);
    }
  }

  const checkedCount = items.filter((i) => i.checked).length;
  return (
    <div className="flex flex-col gap-4" data-testid="shopping-list">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" data-testid="shopping-progress">
          {t.progress(checkedCount, items.length)}
        </p>
        <Button
          variant={shelf ? "default" : "outline"}
          aria-pressed={shelf}
          onClick={() => setShelf((v) => !v)}
          disabled={!hydrated}
          data-testid="shelf-toggle"
        >
          {shelf ? t.shelfOff : t.shelfOn}
        </Button>
      </div>
      {shelf ? <p className="text-sm text-muted-foreground">{t.shelfHint}</p> : null}
      <Alert data-testid="shopping-error">{error}</Alert>

      {items.length === 0 ? (
        <p className="text-muted-foreground" data-testid="shopping-empty">
          {t.noItems}
        </p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t.items}>
          {items.map((item, index) => (
            <li
              key={item.id}
              className="rounded-lg border border-border bg-card"
              data-testid="shopping-item"
              data-checked={item.checked}
            >
              {editing === item.id ? (
                <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2">
                  <Field id={`${ids}-n-${item.id}`} label={t.itemName}>
                    {(p) => (
                      <Input
                        id={p.id}
                        value={draft.name}
                        maxLength={NAME_MAX}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field id={`${ids}-q-${item.id}`} label={t.quantity}>
                    {(p) => (
                      <Input
                        id={p.id}
                        value={draft.quantity}
                        inputMode="decimal"
                        onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field id={`${ids}-u-${item.id}`} label={t.unit}>
                    {(p) => (
                      <Input
                        id={p.id}
                        value={draft.unit}
                        maxLength={UNIT_MAX}
                        onChange={(e) => setDraft({ ...draft, unit: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field id={`${ids}-t-${item.id}`} label={t.note}>
                    {(p) => (
                      <Input
                        id={p.id}
                        value={draft.note}
                        maxLength={200}
                        onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                      />
                    )}
                  </Field>
                  <div className="flex gap-2 sm:col-span-2">
                    <Button size="sm" onClick={() => void saveEdit(item)}>
                      {t.save}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      {t.cancel}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2 p-1 pr-2">
                  <label
                    className={cn(
                      "flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md px-3",
                      shelf ? "min-h-16 text-xl" : "min-h-12",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={item.checked}
                      onChange={() => void toggle(item)}
                      disabled={!hydrated}
                      className={cn("shrink-0 accent-primary", shelf ? "size-8" : "size-6")}
                      aria-label={t.markChecked(item.name)}
                      data-testid="shopping-check"
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block break-words",
                          item.checked && "text-muted-foreground line-through",
                        )}
                      >
                        {quantityLabel(item.quantity, item.unit)} {item.name}
                      </span>
                      {item.note ? (
                        <span className="block text-sm text-muted-foreground">{item.note}</span>
                      ) : null}
                      {item.checked && item.checkedByMe === false ? (
                        <span className="block text-xs text-muted-foreground">
                          {t.checkedByOther}
                        </span>
                      ) : null}
                    </span>
                  </label>
                  {shelf ? null : (
                    <div className="flex flex-wrap gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t.moveUp(item.name)}
                        disabled={!hydrated || index === 0}
                        onClick={() => void move(item, -1)}
                      >
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t.moveDown(item.name)}
                        disabled={!hydrated || index === items.length - 1}
                        onClick={() => void move(item, 1)}
                      >
                        ↓
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => startEdit(item)}>
                        {t.edit}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={t.removeItem(item.name)}
                        onClick={() => void remove(item)}
                      >
                        {t.remove}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {readOnly ? null : (
        <form
          method="post"
          onSubmit={onAdd}
          noValidate
          aria-busy={adding}
          aria-label={t.addTitle}
          className={cn(
            "grid grid-cols-1 gap-3 rounded-lg border border-border p-3 sm:grid-cols-[1fr_7rem_7rem_auto] sm:items-end",
            shelf && "hidden",
          )}
        >
          <Field id={`${ids}-add-name`} label={t.itemName} error={addErrors.name}>
            {(p) => (
              <Input
                id={p.id}
                ref={nameInput}
                name="name"
                maxLength={NAME_MAX}
                autoComplete="off"
                list={`${ids}-suggestions`}
                placeholder={t.itemNamePlaceholder}
                aria-describedby={p.describedBy}
                aria-invalid={p.invalid || undefined}
                data-testid="add-item-name"
              />
            )}
          </Field>
          <Field id={`${ids}-add-qty`} label={t.quantity} error={addErrors.quantity}>
            {(p) => (
              <Input
                id={p.id}
                name="quantity"
                inputMode="decimal"
                autoComplete="off"
                placeholder="1"
                aria-describedby={p.describedBy}
                aria-invalid={p.invalid || undefined}
                data-testid="add-item-quantity"
              />
            )}
          </Field>
          <Field id={`${ids}-add-unit`} label={t.unit}>
            {(p) => (
              <Input
                id={p.id}
                name="unit"
                maxLength={UNIT_MAX}
                autoComplete="off"
                placeholder={t.unitPlaceholder}
              />
            )}
          </Field>
          <Button type="submit" disabled={adding || !hydrated} data-testid="add-item-submit">
            {adding ? t.adding : t.add}
          </Button>
          <datalist id={`${ids}-suggestions`} aria-label={t.suggestionsLabel}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </form>
      )}
    </div>
  );
}
