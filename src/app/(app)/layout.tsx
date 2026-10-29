import type { ReactNode } from "react";

import { AppNav } from "@/components/app/app-nav";
import { LiveUpdates } from "@/components/app/live-updates";
import { InstallPrompt, OfflineSync } from "@/components/app/pwa-app";
import { HouseholdSwitcher, type SwitcherHousehold } from "@/components/family/household-switcher";
import { ro } from "@/messages/ro";
import { listMyHouseholds } from "@/modules/households/households.service";

import { getPageSession } from "../_lib/session";

/**
 * Layout-ul paginilor autentificate. Verificarea sesiunii o face FIECARE pagină
 * (`requirePageSession(<cale>)`), ca redirecționarea la login să păstreze `next`.
 *
 * Accesibilitate (Faza 4): primul element focalizabil e legătura „Sari la conținut” (vizibilă
 * doar la focus), care duce la `<main id="continut">` (focalizabil prin `tabIndex={-1}`).
 *
 * Faza 8: deasupra conținutului, comutatorul gospodăriei active (doar cu ≥ 2 gospodării) și
 * abonarea la actualizările live (`LiveUpdates`, ADR 0017), doar cu sesiune validă. O eroare la
 * citirea gospodăriilor nu blochează pagina (comutatorul lipsește).
 *
 * Faza 9 (ADR 0020): invitația de instalare a PWA și sincronizarea scanărilor offline (doar cu
 * sesiune; coada doar pentru gospodăria activă).
 */
export default async function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = await getPageSession();
  let households: SwitcherHousehold[] = [];
  if (session) {
    try {
      households = (await listMyHouseholds(session.runtime.db, { userId: session.userId })).map(
        (h) => ({ id: h.id, name: h.name, current: h.current }),
      );
    } catch {
      households = [];
    }
  }
  // Faza 9: coada scanărilor offline, legată de utilizator și de gospodăria activă (ADR 0020).
  const currentHousehold = households.find((h) => h.current)?.id ?? null;
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
        {households.length > 1 ? (
          <div className="mb-3">
            <HouseholdSwitcher households={households} />
          </div>
        ) : null}
        {session ? <LiveUpdates /> : null}
        {session ? <InstallPrompt /> : null}
        {session && currentHousehold ? (
          <OfflineSync userId={session.userId} householdId={currentHousehold} />
        ) : null}
        {children}
      </main>
    </div>
  );
}
