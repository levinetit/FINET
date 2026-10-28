import type { ReactNode } from "react";

import { Logo } from "@/app/_components/logo";

/** Antetul paginii: logo-ul pe telefon (pe desktop e în meniul lateral), eticheta și titlul. */
export function PageHeader({
  eyebrow,
  title,
}: Readonly<{ eyebrow?: ReactNode; title: ReactNode }>) {
  return (
    <header className="mb-5 flex flex-col gap-1">
      <span className="mb-2 md:hidden">
        <Logo className="text-3xl" />
      </span>
      {eyebrow ? (
        <span className="text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          {eyebrow}
        </span>
      ) : null}
      <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
    </header>
  );
}
