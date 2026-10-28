import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** Câmpul de text (forma shadcn/ui); starea de eroare vine din `aria-invalid`. */
export function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        "h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 py-2 text-base",
        "text-foreground placeholder:text-muted-foreground",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
        "disabled:cursor-not-allowed disabled:opacity-60",
        "aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

/** Lista de opțiuni, cu același aspect ca `Input`. */
export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 py-2 text-base",
        "text-foreground focus-visible:outline-2 focus-visible:outline-offset-1",
        "focus-visible:outline-ring disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}
