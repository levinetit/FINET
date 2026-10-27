import { ro } from "@/messages/ro";

// Starea de încărcare a paginilor autentificate (schelet, fără conținut real).
export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-4">
      <span className="sr-only">{ro.common.loading}</span>
      <div className="h-8 w-48 animate-pulse rounded-md bg-muted" />
      <div className="h-32 animate-pulse rounded-lg bg-muted" />
      <div className="h-32 animate-pulse rounded-lg bg-muted" />
    </div>
  );
}
