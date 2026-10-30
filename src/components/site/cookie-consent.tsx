"use client";

import { useEffect, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { type ConsentChoice, consentCookie, consentSignals, parseConsent } from "@/lib/consent";
import type { SiteMessages } from "@/messages/en-site";

type GtagWindow = Window & { dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void };

/* gtag.js recunoaște doar obiectul `arguments` în `dataLayer`, nu un tablou. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function gtag(..._args: unknown[]): void {
  const w = window as GtagWindow;
  w.dataLayer = w.dataLayer ?? [];
  // eslint-disable-next-line prefer-rest-params
  w.dataLayer.push(arguments);
}

/** Încarcă gtag.js DOAR după consimțământ; până atunci nu pleacă nicio cerere către Google. */
function loadAnalytics(id: string): void {
  if (document.getElementById("ga-loader")) return;
  const script = document.createElement("script");
  script.id = "ga-loader";
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.append(script);
  gtag("js", new Date());
  gtag("config", id, { anonymize_ip: true });
}

const listeners = new Set<() => void>();
const subscribe = (callback: () => void) => {
  listeners.add(callback);
  return () => void listeners.delete(callback);
};
/** Alegerea curentă din cookie; `"unknown"` pe server (hidratarea nu se desincronizează). */
const snapshot = (): ConsentChoice | "none" => parseConsent(document.cookie) ?? "none";
const serverSnapshot = (): "unknown" => "unknown";

/**
 * Bannerul de cookie-uri și Google Consent Mode v2 (Faza 11, ADR 0027). La montare se declară
 * implicit `denied` pentru toate semnalele; „Accept” le trece pe `granted` (analytics) și încarcă
 * scriptul; „Refuz” păstrează totul oprit. Alegerea stă într-un cookie propriu (`finet_consent`).
 * Fără identificator Google configurat, bannerul nu se afișează (nu există nimic de consimțit).
 */
export function CookieConsent({
  analyticsId,
  t,
}: Readonly<{ analyticsId: string | null; t: SiteMessages["consent"] }>) {
  const choice = useSyncExternalStore(subscribe, snapshot, serverSnapshot);

  useEffect(() => {
    const saved = parseConsent(document.cookie);
    gtag("consent", "default", consentSignals(saved));
    if (saved === "granted" && analyticsId) loadAnalytics(analyticsId);
  }, [analyticsId]);

  if (!analyticsId || choice !== "none") return null;

  function decide(next: ConsentChoice) {
    document.cookie = consentCookie(next, window.location.protocol === "https:");
    gtag("consent", "update", consentSignals(next));
    if (next === "granted" && analyticsId) loadAnalytics(analyticsId);
    for (const callback of listeners) callback();
  }

  return (
    <section
      aria-label={t.region}
      data-testid="cookie-consent"
      className="fixed inset-x-0 bottom-0 z-50 border-t bg-surface p-4 shadow-lg"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-3 md:flex-row md:items-center">
        <p className="text-sm">
          <strong>{t.title}.</strong> {t.body}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" onClick={() => decide("denied")} data-testid="consent-reject">
            {t.reject}
          </Button>
          <Button onClick={() => decide("granted")} data-testid="consent-accept">
            {t.accept}
          </Button>
        </div>
      </div>
    </section>
  );
}
