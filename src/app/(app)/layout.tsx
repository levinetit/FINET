import type { ReactNode } from "react";

import { AppNav } from "@/components/app/app-nav";

/**
 * Layout-ul paginilor autentificate. Verificarea sesiunii o face FIECARE pagină
 * (`requirePageSession(<cale>)`), ca redirecționarea la login să păstreze `next`.
 */
export default function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="min-h-dvh px-4 md:grid md:grid-cols-[228px_minmax(0,1fr)] md:gap-8">
      <AppNav />
      <main className="mx-auto w-full max-w-[1180px] min-w-0 pt-5 pb-28 md:pt-7 md:pb-12">
        {children}
      </main>
    </div>
  );
}
