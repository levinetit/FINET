"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { offlineScans } from "@/app/_lib/offline-scans-client";
import {
  type InstallMode,
  installMode,
  isIosDevice,
  readDismissed,
  writeDismissed,
} from "@/app/_lib/pwa-ui";
import { ro } from "@/messages/ro";

/*
 * Componentele PWA ale zonei autentificate (Faza 9, ADR 0020), importate DOAR de layout-ul
 * `(app)`: coada offline și invitația de instalare nu ajung în bundle-ul paginilor publice
 * (`/login`, `/register`). Înregistrarea service worker-ului e în `./pwa.tsx` (layout-ul rădăcină).
 */

type InstallEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function localStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isStandalone(): boolean {
  try {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

/**
 * Invitația de instalare (Faza 9): pe Android/Chromium butonul „Instalează” (evenimentul
 * `beforeinstallprompt`, amânat), pe iPhone/iPad instrucțiunile pentru Safari. Se închide și nu
 * mai reapare (preferința în `localStorage`, în try/catch; fără stocare: doar pentru pagina
 * curentă). Nu apare în aplicația deja instalată.
 */
export function InstallPrompt() {
  const [mode, setMode] = useState<InstallMode>("none");
  const deferred = useRef<InstallEvent | null>(null);

  useEffect(() => {
    const state = () => ({
      dismissed: readDismissed(localStore()),
      standalone: isStandalone(),
      hasPrompt: deferred.current !== null,
      ios: isIosDevice(navigator.userAgent, navigator.maxTouchPoints ?? 0),
    });
    const onPrompt = (e: Event) => {
      e.preventDefault();
      deferred.current = e as InstallEvent;
      setMode(installMode(state()));
    };
    const onInstalled = () => {
      writeDismissed(localStore());
      deferred.current = null;
      setMode("none");
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    setMode(installMode(state()));
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  function dismiss() {
    writeDismissed(localStore());
    setMode("none");
  }

  async function install() {
    const event = deferred.current;
    if (!event) return;
    deferred.current = null;
    try {
      await event.prompt();
      await event.userChoice;
    } catch {
      // browserul a refuzat afișarea: nimic de făcut
    }
    dismiss();
  }

  if (mode === "none") return null;
  return (
    <aside
      aria-labelledby="install-title"
      data-testid="install-prompt"
      className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-card p-4"
    >
      <div className="min-w-0 flex-1">
        <h2 id="install-title" className="font-semibold">
          {ro.pwa.installTitle}
        </h2>
        <p className="text-sm text-muted-foreground">
          {mode === "ios" ? ro.pwa.iosBody : ro.pwa.installBody}{" "}
          <Link href="/help#instalare" className="font-semibold text-primary underline">
            {ro.pwa.guideLink}
          </Link>
        </p>
      </div>
      <div className="flex gap-2">
        {mode === "prompt" ? (
          <button
            type="button"
            onClick={() => void install()}
            className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {ro.pwa.install}
          </button>
        ) : null}
        <button
          type="button"
          onClick={dismiss}
          data-testid="install-dismiss"
          className="rounded-md px-3 py-2 text-sm text-muted-foreground underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {ro.pwa.notNow}
        </button>
      </div>
    </aside>
  );
}

/**
 * Pornește coada scanărilor offline pentru utilizatorul și gospodăria curente (layout-ul
 * autentificat): curăță intrările altor utilizatori și încarcă ce e în așteptare (ADR 0020).
 */
export function OfflineSync({
  userId,
  householdId,
}: Readonly<{ userId: string; householdId: string }>) {
  useEffect(() => {
    void offlineScans().start({ userId, householdId });
  }, [userId, householdId]);
  return null;
}
