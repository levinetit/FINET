"use client";

import { type ReactNode, useState } from "react";

import { Button } from "@/components/ui/button";
import { ro } from "@/messages/ro";

/**
 * Ștergerea cu confirmare (ca la sesiuni, Faza 1): primul clic arată întrebarea, al doilea
 * („Da, șterge”) execută. `children` poate adăuga controale în panoul de confirmare (de exemplu
 * categoria care preia tranzacțiile).
 */
export function ConfirmButton({
  label,
  question,
  confirmLabel = ro.ledger.confirmDelete,
  busy,
  disabled,
  onConfirm,
  children,
}: Readonly<{
  label: string;
  question: string;
  confirmLabel?: string;
  busy: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}>) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button variant="outline" size="sm" disabled={disabled || busy} onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-bad bg-bad-soft p-3"
      role="group"
      aria-label={question}
    >
      <p className="text-sm font-medium">{question}</p>
      {children}
      <div className="flex flex-wrap gap-2">
        <Button variant="destructive" size="sm" disabled={busy} onClick={onConfirm}>
          {busy ? ro.ledger.deleting : confirmLabel}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setOpen(false)}>
          {ro.ledger.cancel}
        </Button>
      </div>
    </div>
  );
}
