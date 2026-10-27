import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Combină clase Tailwind, rezolvând conflictele (utilitarul standard shadcn/ui). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
