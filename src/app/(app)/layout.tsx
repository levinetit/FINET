import type { ReactNode } from "react";

import { AppNav } from "@/components/app/app-nav";
import { ro } from "@/messages/ro";

/**
 * Layout-ul paginilor autentificate. Verificarea sesiunii o face FIECARE pagină
 * (`requirePageSession(<cale>)`), ca redirecționarea la login să păstreze `next`.
 *
 * Accesibilitate (Faza 4): primul element focalizabil e legătura „Sari la conținut” (vizibilă
 * doar la focus), care duce la `<main id="continut">` (focalizabil prin `tabIndex={-1}`).
 */
export default function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="min-h-dvh px-4 md:grid md:grid-cols-[228px_minmax(0,1fr)] md:gap-8">
      <a href="#continut" className="skip-link">
        {ro.common.skipToContent}
      </a>
      <AppNav />
      <main
        id="continut"
        tabIndex={-1}
        className="mx-auto w-full max-w-[1180px] min-w-0 pt-5 pb-28 focus:outline-none md:pt-7 md:pb-12"
      >
        {children}
      </main>
    </div>
  );
}
