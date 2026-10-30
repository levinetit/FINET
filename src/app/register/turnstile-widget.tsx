"use client";

import { useEffect, useRef } from "react";

/**
 * Widgetul Cloudflare Turnstile (Faza 11-C2, ADR 0030), randare explicită. Scriptul se încarcă doar
 * aici, doar pe `/register` (CSP-ul permite `challenges.cloudflare.com` numai pe această pagină).
 * Tokenul e de unică folosință și valabil 5 minute: după orice cerere eșuată părintele crește
 * `resetKey`, iar widgetul își cere un token nou.
 */

type TurnstileApi = {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_BASE = "https://challenges.cloudflare.com/turnstile/v0/api.js";

export function TurnstileWidget({
  siteKey,
  onToken,
  resetKey,
}: Readonly<{
  siteKey: string;
  onToken: (token: string | null) => void;
  resetKey: number;
}>) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const mount = () => {
      if (cancelled || !container.current || !window.turnstile || widgetId.current) return;
      widgetId.current = window.turnstile.render(container.current, {
        sitekey: siteKey,
        callback: (token) => onToken(token),
        "expired-callback": () => onToken(null),
        "error-callback": () => onToken(null),
      });
    };
    if (window.turnstile) {
      mount();
    } else {
      let script = document.querySelector<HTMLScriptElement>(`script[src^="${SCRIPT_BASE}"]`);
      if (!script) {
        script = document.createElement("script");
        script.src = `${SCRIPT_BASE}?render=explicit`;
        script.async = true;
        document.head.append(script);
      }
      script.addEventListener("load", mount);
    }
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey, onToken]);

  useEffect(() => {
    if (resetKey > 0 && widgetId.current && window.turnstile) {
      window.turnstile.reset(widgetId.current);
    }
  }, [resetKey]);

  return <div ref={container} data-testid="turnstile-widget" />;
}
