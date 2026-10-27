import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** Eticheta unui câmp (forma shadcn/ui, fără `@radix-ui/react-label`: `<label>` nativ). */
export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn("text-sm font-medium text-foreground", className)} {...props} />;
}
