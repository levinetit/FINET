import type { ReactNode } from "react";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Un câmp de formular accesibil: eticheta legată de control (`htmlFor`), indiciul și eroarea
 * legate prin `aria-describedby`, eroarea anunțată (`role="alert"` în `FieldError`). Controlul
 * primește `id`-ul, `describedBy` și `invalid` prin funcția `children`.
 */
export function Field({
  id,
  label,
  hint,
  error,
  optional,
  className,
  children,
}: Readonly<{
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  optional?: string;
  className?: string;
  children: (props: Readonly<{ id: string; describedBy?: string; invalid: boolean }>) => ReactNode;
}>) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label htmlFor={id}>
        {label}
        {optional ? (
          <span className="ml-1 font-normal text-muted-foreground">({optional})</span>
        ) : null}
      </Label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm text-bad" data-testid={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
