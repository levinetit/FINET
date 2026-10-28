import { cn } from "@/lib/utils";

/**
 * Culoarea unei etichete (`#rrggbb` validat de server) ca atribut SVG `fill`, nu ca `style=`
 * (CSP cu nonce). Fără culoare: un cerc gol în culoarea textului secundar.
 */
export function TagDot({
  color,
  className,
}: Readonly<{ color: string | null; className?: string }>) {
  const safe = color && /^#[0-9a-f]{6}$/i.test(color) ? color : null;
  return (
    <svg
      viewBox="0 0 10 10"
      className={cn("size-2.5 flex-none", className)}
      aria-hidden
      focusable="false"
    >
      {safe ? (
        <circle cx="5" cy="5" r="5" fill={safe} />
      ) : (
        <circle
          cx="5"
          cy="5"
          r="4"
          fill="none"
          strokeWidth="1.5"
          className="stroke-muted-foreground"
        />
      )}
    </svg>
  );
}

/** O etichetă afișată pe o tranzacție. */
export function TagChip({ name, color }: Readonly<{ name: string; color: string | null }>) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-xs font-medium"
      data-testid="tag-chip"
    >
      <TagDot color={color} />
      {name}
    </span>
  );
}
