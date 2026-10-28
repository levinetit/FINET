"use client";

import { useEffect, useState } from "react";

import {
  DIRTY_ATTRIBUTE,
  type RecoveryDecision,
  type StorageLike,
  decideRecovery,
  isChunkLoadError,
  isStaticAssetUrl,
  markReload,
  readLastReload,
  recentReloads,
} from "@/app/_lib/chunk-recovery";
import { ro } from "@/messages/ro";

/** Evenimentul prin care paginile de eroare cer bannerul (decizia `banner`). */
const BANNER_EVENT = "finet:new-version";

function sessionStore(): StorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Există în pagină un formular cu modificări necomise? */
export function hasDirtyForm(): boolean {
  return document.querySelector(`form[${DIRTY_ATTRIBUTE}]`) !== null;
}

/**
 * Aplică decizia: reîncarcă pagina (marcajul în `sessionStorage` scris ÎNAINTE) sau anunță
 * bannerul. Apelată de ascultătorii globali și de `error.tsx` / `global-error.tsx`.
 */
export function recoverFromChunkError(): RecoveryDecision {
  const now = Date.now();
  const storage = sessionStore();
  const decision = decideRecovery({
    now,
    lastReloadAt: readLastReload(storage),
    dirty: hasDirtyForm(),
    recentCount: recentReloads(storage, now).length,
    online: typeof navigator === "undefined" ? true : navigator.onLine,
  });
  if (decision === "reload" && markReload(storage, now)) {
    window.location.reload();
    return "reload";
  }
  window.dispatchEvent(new Event(BANNER_EVENT));
  return "banner";
}

/** Formularul care conține ținta evenimentului, dacă poate pierde date (nu cele `method="get"`). */
function trackedForm(target: EventTarget | null): HTMLFormElement | null {
  if (!(target instanceof Element)) return null;
  const form = target.closest("form");
  if (!form || form.getAttribute("method")?.toLowerCase() === "get") return null;
  return form;
}

/**
 * Montată o singură dată, în layout-ul rădăcină. Detectează fișierele statice lipsă după un
 * deploy (`ChunkLoadError`, import dinamic eșuat, `<script>`/`<link>` din `/_next/static/` cu
 * eroare de încărcare) și reîncarcă pagina, cel mult o dată la 8 secunde. Formularele cu
 * modificări primesc `data-dirty` la prima tastare (și îl păstrează până la `reset` sau până
 * dispar din pagină): cu un astfel de formular, în locul reîncărcării apare bannerul.
 */
export function ChunkRecovery() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onInput = (e: Event) => trackedForm(e.target)?.setAttribute(DIRTY_ATTRIBUTE, "");
    const onReset = (e: Event) => trackedForm(e.target)?.removeAttribute(DIRTY_ATTRIBUTE);
    const onError = (e: Event) => {
      const el = e.target;
      const url =
        el instanceof HTMLScriptElement
          ? el.src
          : el instanceof HTMLLinkElement && el.rel === "stylesheet"
            ? el.href
            : null;
      if (url !== null) {
        if (isStaticAssetUrl(url, window.location.origin)) recoverFromChunkError();
        return;
      }
      if (e instanceof ErrorEvent && isChunkLoadError(e.error ?? e.message)) {
        recoverFromChunkError();
      }
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      if (isChunkLoadError(e.reason)) recoverFromChunkError();
    };
    const onBanner = () => setVisible(true);

    document.addEventListener("input", onInput, true);
    document.addEventListener("change", onInput, true);
    document.addEventListener("reset", onReset, true);
    // Faza de captură: erorile de încărcare ale elementelor nu urcă (nu fac bubbling).
    window.addEventListener("error", onError, true);
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener(BANNER_EVENT, onBanner);
    return () => {
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("change", onInput, true);
      document.removeEventListener("reset", onReset, true);
      window.removeEventListener("error", onError, true);
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener(BANNER_EVENT, onBanner);
    };
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        visible
          ? "fixed inset-x-0 top-0 z-50 flex flex-wrap items-center justify-center gap-3 border-b border-warn bg-warn-soft px-4 py-2 text-sm text-fg"
          : "sr-only"
      }
    >
      {visible ? (
        <>
          <span>{ro.common.newVersion}</span>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border border-border bg-surface px-3 py-1 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {ro.common.reload}
          </button>
          <button
            type="button"
            onClick={() => setVisible(false)}
            className="rounded-md px-3 py-1 text-muted-foreground underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {ro.common.dismiss}
          </button>
        </>
      ) : null}
    </div>
  );
}
