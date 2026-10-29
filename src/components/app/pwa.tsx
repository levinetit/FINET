"use client";

import { useEffect, useRef, useState } from "react";

import { ro } from "@/messages/ro";

import { hasDirtyForm } from "./chunk-recovery";

/** O oră între verificările de actualizare la revenirea pe filă. */
const UPDATE_CHECK_MS = 3600 * 1000;

const bannerButton =
  "rounded-md border border-border bg-surface px-3 py-1 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * Înregistrarea service worker-ului (Faza 9, ADR 0020), montată o dată în layout-ul rădăcină.
 * Actualizare controlată: o versiune nouă instalată rămâne `waiting`; bannerul „Versiune nouă”
 * o activează doar la clic („Actualizează” → `SKIP_WAITING`), iar pagina se reîncarcă după
 * `controllerchange`. Cu un formular necomis (`data-dirty`), actualizarea e amânată: nu pierdem
 * ce s-a tastat. Fără `serviceWorker` sau în afara unui context securizat nu face nimic.
 */
export function ServiceWorkerRegistration() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [dirty, setDirty] = useState(false);
  const requested = useRef(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    const sw = navigator.serviceWorker;
    let registration: ServiceWorkerRegistration | null = null;
    let lastCheck = Date.now();
    const offer = (worker: ServiceWorker | null) => {
      // Doar o ACTUALIZARE (există deja un controller); prima instalare nu cere nimic.
      if (worker && sw.controller) setWaiting(worker);
    };
    const onControllerChange = () => {
      if (requested.current) window.location.reload();
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !registration) return;
      if (Date.now() - lastCheck < UPDATE_CHECK_MS) return;
      lastCheck = Date.now();
      registration.update().catch(() => undefined);
    };
    sw.addEventListener("controllerchange", onControllerChange);
    document.addEventListener("visibilitychange", onVisible);
    sw.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        registration = reg;
        offer(reg.waiting);
        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed") offer(reg.waiting ?? installing);
          });
        });
      })
      .catch(() => undefined);
    return () => {
      sw.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  function activate() {
    if (!waiting) return;
    if (hasDirtyForm()) {
      setDirty(true);
      return;
    }
    requested.current = true;
    waiting.postMessage({ type: "SKIP_WAITING" });
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="sw-update"
      className={
        waiting
          ? "fixed inset-x-0 top-0 z-50 flex flex-wrap items-center justify-center gap-3 border-b border-warn bg-warn-soft px-4 py-2 text-sm text-fg"
          : "sr-only"
      }
    >
      {waiting ? (
        <>
          <span>{dirty ? ro.pwa.updateDirty : ro.pwa.updateReady}</span>
          <button type="button" onClick={activate} className={bannerButton}>
            {ro.pwa.update}
          </button>
          <button
            type="button"
            onClick={() => setWaiting(null)}
            className="rounded-md px-3 py-1 text-muted-foreground underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {ro.pwa.later}
          </button>
        </>
      ) : null}
    </div>
  );
}
