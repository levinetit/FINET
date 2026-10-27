"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { Logo } from "@/app/_components/logo";
import { cn } from "@/lib/utils";
import { ro } from "@/messages/ro";

import { HomeIcon, LogoutIcon, UserIcon } from "./icons";

const ITEMS = [
  { href: "/dashboard", label: ro.nav.dashboard, icon: HomeIcon },
  { href: "/profile", label: ro.nav.profile, icon: UserIcon },
] as const;

const itemClass =
  "flex w-full flex-col items-center gap-0.5 rounded-lg px-1 pt-2 pb-2.5 text-xs text-muted-foreground " +
  "md:flex-row md:gap-3 md:px-3 md:py-2.5 md:text-[0.95rem] hover:text-foreground";

/**
 * Navigarea (master prompt 3.4, demo): bară jos pe telefon, meniu lateral pe desktop. Doar
 * paginile care există în Faza 1. Deconectarea e un `POST /api/auth/sign-out` (Better Auth
 * verifică originea și șterge sesiunea din bază și cookie-ul).
 */
export function AppNav() {
  const pathname = usePathname();
  const [leaving, setLeaving] = useState(false);
  const [failed, setFailed] = useState(false);

  async function logout() {
    setLeaving(true);
    setFailed(false);
    try {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      // 2xx sau „fără sesiune” (4xx în afară de 403 = origine refuzată): oricum la login.
      if (
        response.ok ||
        (response.status >= 400 && response.status < 500 && response.status !== 403)
      ) {
        const target = "/login";
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- navigare completă intenționată: sesiunea s-a schimbat, cache-ul routerului trebuie golit
        window.location.assign(target);
        return;
      }
    } catch {
      // mai jos
    }
    setLeaving(false);
    setFailed(true);
  }

  return (
    <nav
      aria-label={ro.nav.label}
      className={cn(
        "fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card px-2 pb-[env(safe-area-inset-bottom)]",
        "md:sticky md:top-0 md:flex md:h-dvh md:flex-col md:gap-6 md:border-t-0 md:border-r",
        "md:bg-transparent md:px-0 md:py-6 md:pr-4",
      )}
    >
      <div className="hidden md:block">
        <Link href="/dashboard" aria-label={`${ro.app.name}, ${ro.nav.dashboard}`}>
          <Logo className="text-3xl" />
        </Link>
        <p className="mt-1 text-sm text-muted-foreground">{ro.app.tagline}</p>
      </div>
      <ul className="grid grid-cols-3 md:grid-cols-1 md:gap-0.5">
        {ITEMS.map(({ href, label, icon: ItemIcon }) => {
          const current = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  itemClass,
                  current && "font-semibold text-primary md:bg-accent hover:text-primary",
                )}
              >
                <ItemIcon />
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
        <li className="md:mt-4">
          <button type="button" onClick={logout} disabled={leaving} className={itemClass}>
            <LogoutIcon />
            <span>{leaving ? ro.nav.loggingOut : ro.nav.logout}</span>
          </button>
        </li>
      </ul>
      <p role="alert" className={failed ? "px-2 pb-2 text-sm text-bad md:px-3" : "sr-only"}>
        {failed ? ro.nav.logoutError : null}
      </p>
    </nav>
  );
}
