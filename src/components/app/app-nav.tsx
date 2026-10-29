"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Logo } from "@/app/_components/logo";
import { cn } from "@/lib/utils";
import { useHydrated } from "@/app/_lib/use-hydrated";
import { ro } from "@/messages/ro";

import {
  ChartIcon,
  FolderIcon,
  HomeIcon,
  ListIcon,
  LogoutIcon,
  MoreIcon,
  PieIcon,
  ReceiptIcon,
  RepeatIcon,
  ScanIcon,
  TagIcon,
  TargetIcon,
  UserIcon,
  WalletIcon,
} from "./icons";

// Faza 6 (ADR 0015): pe telefon, „Scanează” (`/import`) ia locul lui „Bugete” în bara de jos (bonurile
// se fotografiază pe loc, în magazin; bugetele se consultă mai rar și rămân la un clic, în „Mai
// mult”). Pe desktop: „Import” și „Bonuri” în meniul lateral.
const ITEMS = [
  { href: "/dashboard", label: ro.nav.dashboard, icon: HomeIcon, mobile: true },
  { href: "/transactions", label: ro.nav.transactions, icon: ListIcon, mobile: true },
  {
    href: "/import",
    label: ro.nav.import,
    mobileLabel: ro.nav.scan,
    icon: ScanIcon,
    mobile: true,
  },
  { href: "/receipts", label: ro.nav.receipts, icon: ReceiptIcon, mobile: false },
  { href: "/accounts", label: ro.nav.accounts, icon: WalletIcon, mobile: false },
  { href: "/categories", label: ro.nav.categories, icon: FolderIcon, mobile: false },
  { href: "/tags", label: ro.nav.tags, icon: TagIcon, mobile: false },
  { href: "/budgets", label: ro.nav.budgets, icon: PieIcon, mobile: false },
  { href: "/goals", label: ro.nav.goals, icon: TargetIcon, mobile: false },
  { href: "/recurring", label: ro.nav.recurring, icon: RepeatIcon, mobile: false },
  { href: "/reports", label: ro.nav.reports, icon: ChartIcon, mobile: true },
  { href: "/profile", label: ro.nav.profile, icon: UserIcon, mobile: false },
] as const;

const itemClass =
  "flex w-full min-w-0 flex-col items-center gap-0.5 rounded-lg px-0.5 pt-2 pb-2.5 text-center " +
  "text-[0.68rem] leading-tight break-words text-muted-foreground " +
  "md:flex-row md:gap-3 md:px-3 md:py-2.5 md:text-left md:text-[0.95rem] hover:text-foreground " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const panelItemClass =
  "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-base text-foreground hover:bg-accent " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * Navigarea (master prompt 3.4, demo). Pe desktop: meniul lateral cu toate paginile. Pe telefon:
 * bara de jos cu Acasă, Tranzacții, Scanează, Rapoarte și „Mai mult” (Faza 6: „Scanează” a luat
 * locul lui „Bugete”, mutat în „Mai mult”), iar „Mai mult” deschide panoul cu celelalte pagini și deconectarea
 * (`aria-expanded`; la deschidere focusul trece pe primul link, Escape îl închide și întoarce
 * focusul pe buton). Cele două liste nu sunt vizibile simultan (`md:hidden` /
 * `hidden md:grid`), deci fiecare link apare o singură dată în arborele de accesibilitate.
 * Deconectarea e un `POST /api/auth/sign-out` (Better Auth verifică originea și șterge sesiunea
 * din bază și cookie-ul).
 */
export function AppNav() {
  const pathname = usePathname();
  // `/transfers/new` ține de tranzacții.
  const section = pathname.startsWith("/transfers") ? "/transactions" : pathname;
  const [leaving, setLeaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const hydrated = useHydrated();
  // Faza 4 (tastatură): la deschidere focusul trece pe primul link din „Mai mult”; la Escape
  // panoul se închide și focusul revine pe butonul „Mai mult”.
  const moreButton = useRef<HTMLButtonElement>(null);
  const morePanel = useRef<HTMLDivElement>(null);
  const focusFirst = useRef(false);
  useEffect(() => {
    if (moreOpen && focusFirst.current) {
      focusFirst.current = false;
      morePanel.current?.querySelector<HTMLElement>("a, button")?.focus();
    }
  }, [moreOpen]);

  function closeMore(returnFocus: boolean) {
    setMoreOpen(false);
    if (returnFocus) moreButton.current?.focus();
  }

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

  const isCurrent = (href: string) => section === href || section.startsWith(`${href}/`);
  const moreCurrent = ITEMS.some((i) => !i.mobile && isCurrent(i.href));
  const logoutLabel = leaving ? ro.nav.loggingOut : ro.nav.logout;

  return (
    <nav
      aria-label={ro.nav.label}
      onKeyDown={(e) => {
        if (e.key === "Escape" && moreOpen) closeMore(true);
      }}
      className={cn(
        "fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card px-2 pb-[env(safe-area-inset-bottom)]",
        "md:sticky md:top-0 md:flex md:h-dvh md:flex-col md:gap-6 md:overflow-y-auto md:border-t-0 md:border-r",
        "md:bg-transparent md:px-0 md:py-6 md:pr-4",
      )}
    >
      <div className="hidden md:block">
        <Link href="/dashboard" aria-label={`${ro.app.name}, ${ro.nav.dashboard}`}>
          <Logo className="text-3xl" />
        </Link>
        <p className="mt-1 text-sm text-muted-foreground">{ro.app.tagline}</p>
      </div>

      {/* Desktop: toate paginile. */}
      <ul className="hidden md:grid md:grid-cols-1 md:gap-0.5">
        {ITEMS.map(({ href, label, icon: ItemIcon }) => (
          <li key={href}>
            <Link
              href={href}
              aria-current={isCurrent(href) ? "page" : undefined}
              className={cn(
                itemClass,
                isCurrent(href) && "font-semibold text-primary md:bg-accent hover:text-primary",
              )}
            >
              <ItemIcon />
              <span>{label}</span>
            </Link>
          </li>
        ))}
        <li className="md:mt-4">
          <button
            type="button"
            onClick={logout}
            disabled={leaving || !hydrated}
            className={itemClass}
          >
            <LogoutIcon />
            <span>{logoutLabel}</span>
          </button>
        </li>
      </ul>

      {/* Telefon: panoul „Mai mult”, deasupra barei. */}
      <div
        id="nav-more"
        ref={morePanel}
        hidden={!moreOpen}
        className="border-b border-border pt-2 pb-1 md:hidden"
        role="group"
        aria-label={ro.nav.moreLabel}
      >
        <ul className="grid grid-cols-2 gap-1">
          {ITEMS.filter((i) => !i.mobile).map(({ href, label, icon: ItemIcon }) => (
            <li key={href}>
              <Link
                href={href}
                aria-current={isCurrent(href) ? "page" : undefined}
                onClick={() => setMoreOpen(false)}
                className={cn(panelItemClass, isCurrent(href) && "font-semibold text-primary")}
              >
                <ItemIcon />
                <span>{label}</span>
              </Link>
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={logout}
              disabled={leaving || !hydrated}
              className={panelItemClass}
            >
              <LogoutIcon />
              <span>{logoutLabel}</span>
            </button>
          </li>
        </ul>
      </div>

      {/* Telefon: bara de jos. */}
      <ul className="grid grid-cols-5 md:hidden">
        {ITEMS.filter((i) => i.mobile).map((item) => {
          const { href, icon: ItemIcon } = item;
          const label = "mobileLabel" in item ? item.mobileLabel : item.label;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={isCurrent(href) ? "page" : undefined}
                className={cn(
                  itemClass,
                  isCurrent(href) && "font-semibold text-primary hover:text-primary",
                )}
              >
                <ItemIcon />
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            ref={moreButton}
            aria-expanded={moreOpen}
            aria-controls="nav-more"
            onClick={() => {
              focusFirst.current = !moreOpen;
              setMoreOpen((open) => !open);
            }}
            className={cn(itemClass, moreCurrent && "font-semibold text-primary")}
          >
            <MoreIcon />
            <span>{ro.nav.more}</span>
          </button>
        </li>
      </ul>
      <p role="alert" className={failed ? "px-2 pb-2 text-sm text-bad md:px-3" : "sr-only"}>
        {failed ? ro.nav.logoutError : null}
      </p>
    </nav>
  );
}
