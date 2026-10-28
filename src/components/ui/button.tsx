import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Butonul (forma shadcn/ui „new-york”, scris de mână): fără `@radix-ui/react-slot` și
 * `class-variance-authority`, ca să nu adăugăm dependențe pentru câteva variante. Culorile vin
 * doar din tokeni (`globals.css`).
 */

const VARIANTS = {
  default: "bg-primary text-primary-foreground hover:opacity-90",
  outline: "border border-border bg-card text-foreground hover:bg-accent",
  secondary: "bg-secondary text-secondary-foreground hover:bg-accent",
  ghost: "text-foreground hover:bg-accent",
  destructive: "bg-destructive text-destructive-foreground hover:opacity-90",
  link: "text-primary underline-offset-4 hover:underline",
} as const;

const SIZES = {
  default: "h-11 px-4 py-2",
  sm: "h-9 px-3 text-sm",
} as const;

export type ButtonProps = ComponentProps<"button"> & {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
};

export function buttonClasses(
  variant: keyof typeof VARIANTS = "default",
  size: keyof typeof SIZES = "default",
  className?: string,
): string {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap",
    "transition-colors focus-visible:outline-2 focus-visible:outline-offset-2",
    "focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-60",
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={buttonClasses(variant, size, className)} {...props} />;
}
