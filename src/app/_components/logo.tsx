import { cn } from "@/lib/utils";

type LogoProps = {
  className?: string;
};

/**
 * Wordmark-ul FINET (master prompt 3.4): „FIN” + simbolul-grafic în locul lui „e” + „t”.
 * Linia folosește tokenul `accent`, moneda tokenul `marker`. La hover linia se redesenează;
 * animația e oprită pentru `prefers-reduced-motion` (vezi `.finet-logo` în globals.css).
 */
export function Logo({ className }: LogoProps) {
  return (
    <span
      role="img"
      aria-label="FINET"
      className={cn(
        "finet-logo inline-flex items-center font-display leading-none text-fg",
        className,
      )}
    >
      <span aria-hidden="true" className="font-extrabold uppercase tracking-[-0.03em]">
        FIN
      </span>
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="1 2 17 22"
        fill="none"
        className="finet-logo-mark mr-[0.01em] ml-[0.04em] h-[1.1em] w-[0.7em] flex-none overflow-visible"
      >
        <path
          className="finet-logo-line"
          d="M1.5 18.5 H5 L7 22.5 L10 5 L12.6 17 L14.2 13.5 L16.5 3.5"
          stroke="var(--accent)"
          strokeWidth={3.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        <circle cx="16.5" cy="3.5" r="1.9" fill="var(--marker)" />
      </svg>
      <span aria-hidden="true" className="font-semibold tracking-[-0.02em] text-muted">
        t
      </span>
    </span>
  );
}
