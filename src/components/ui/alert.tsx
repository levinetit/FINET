import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Mesaj de stare. Regiunea `aria-live` există mereu în pagină (și goală), ca cititoarele de
 * ecran să anunțe mesajul când apare.
 */
export function Alert({
  className,
  tone = "error",
  children,
  ...props
}: ComponentProps<"div"> & { tone?: "error" | "ok" | "info" }) {
  const empty =
    children === null || children === undefined || children === false || children === "";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
      className={cn(
        empty
          ? "sr-only"
          : "rounded-md border px-3 py-2 text-sm " +
              (tone === "error"
                ? "border-bad bg-bad-soft text-fg"
                : tone === "ok"
                  ? "border-ok bg-ok-soft text-fg"
                  : "border-border bg-muted text-fg"),
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
